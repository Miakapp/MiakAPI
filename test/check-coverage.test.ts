import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `templates/home` is a project in its own right: it resolves `miakapi` and
// `@miakapp/cli` through `file:` links that exist only after its own install.
// The root sweep once reached into it, and the test resolved `miakapi` by
// self-reference instead of through the link the template ships — green on a
// Bun that self-references, red on the one CI pins, and never a real exercise
// of the template either way. Hence the two halves pinned here: the root sweep
// runs exactly the files the root install can resolve, and everything it leaves
// out is checked by a script CI actually runs.
//
// The sweep is written as globs because `bun test foo/` is a substring filter,
// not a directory scope: `test/` also selects `templates/home/test/`.

const ROOT = resolve(import.meta.dir, '..');
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', '.contract', '.contract-dist']);

type Manifest = {
  name?: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
};

function manifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, directory, 'package.json'), 'utf8')) as Manifest;
}

const root = manifest('.');

/** The directory holding `path`, or `.` when it sits at the repository root. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '.' : path.slice(0, cut);
}

function walk(directory: string, visit: (relativePath: string, entry: string) => void): void {
  for (const entry of readdirSync(join(ROOT, directory === '.' ? '' : directory))) {
    if (SKIP.has(entry)) continue;
    const child = directory === '.' ? entry : `${directory}/${entry}`;
    visit(child, entry);
    if (statSync(join(ROOT, child)).isDirectory()) walk(child, visit);
  }
}

/** Every Bun test file in the working tree. */
function testFiles(): string[] {
  const found: string[] = [];
  walk('.', (child, entry) => {
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.mjs')) found.push(child);
  });
  return found.sort();
}

/** The directories the root `workspaces` globs resolve to. */
function workspaceMembers(): string[] {
  const members: string[] = [];
  for (const pattern of root.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      members.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(ROOT, parent))) {
      if (SKIP.has(entry)) continue;
      if (statSync(join(ROOT, parent, entry)).isDirectory()) members.push(`${parent}/${entry}`);
    }
  }
  return members.sort();
}

/**
 * Directories carrying their own manifest that the root install does not link:
 * neither the root itself nor a workspace member. Their tests cannot run from
 * the root sweep, so each one needs a check of its own.
 */
function standaloneProjects(): string[] {
  const members = new Set(workspaceMembers());
  const projects: string[] = [];
  walk('.', (child, entry) => {
    if (entry !== 'package.json') return;
    const directory = parentOf(child);
    if (directory === '.' || members.has(directory)) return;
    projects.push(directory);
  });
  return projects.sort();
}

/** The files the root `test` script hands to `bun test`, glob-expanded as its shell would. */
function sweptFiles(): string[] {
  const script = root.scripts?.test ?? '';
  const match = /^bun test\b(.*)$/.exec(script.trim());
  if (match === null) throw new Error(`the root test script is not a bun test run: ${script}`);
  const patterns = match[1]!.split(/\s+/).filter((word) => word !== '' && !word.startsWith('-'));
  if (patterns.length === 0) throw new Error('the root test script sweeps the whole tree');

  const files = new Set<string>();
  for (const pattern of patterns) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) files.add(file);
  }
  return [...files].sort();
}

/**
 * Follows a script through `bun run` references and reports every directory it
 * ends up checking, either by entering it (`cd`) or by filtering to the
 * workspace package that lives there (`bun --filter`).
 */
function directoriesCheckedBy(entry: string): string[] {
  const byName = new Map(workspaceMembers().map((directory) => [manifest(directory).name, directory]));
  const reached = new Set<string>();
  const seen = new Set<string>();

  const follow = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const script = root.scripts?.[name];
    if (script === undefined) throw new Error(`${name} is not a root script`);
    for (const step of script.split('&&').map((part) => part.trim())) {
      const run = /^bun run ([\w:-]+)$/.exec(step);
      if (run !== null) {
        follow(run[1]!);
        continue;
      }
      const filtered = /^bun --filter (\S+)\b/.exec(step);
      if (filtered !== null) {
        const directory = byName.get(filtered[1]!);
        if (directory === undefined) throw new Error(`${filtered[1]} is not a workspace package`);
        reached.add(directory);
        continue;
      }
      const entered = /^cd (\S+)$/.exec(step);
      if (entered !== null) reached.add(entered[1]!.replace(/\/+$/, ''));
    }
  };

  follow(entry);
  return [...reached].sort();
}

/** The root scripts the CI workflow runs. */
function scriptsRunByCi(): string[] {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  return [...workflow.matchAll(/^\s*- run: bun run (\S+)\s*$/gm)].map((match) => match[1]!);
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

describe('the checks CI runs cover every test on disk', () => {
  // Without these the rest could pass by discovering nothing at all.
  test('discovery finds what this repository is known to contain', () => {
    expect(testFiles()).toContain('test/socket.test.ts');
    expect(testFiles()).toContain('templates/home/test/home.test.ts');
    expect(workspaceMembers()).toContain('packages/cli');
    expect(standaloneProjects()).toEqual(['templates/home']);
    expect(sweptFiles().length).toBeGreaterThan(10);
  });

  test('the sweep runs no test from a project the root install does not link', () => {
    const projects = standaloneProjects();
    const trespassing = sweptFiles()
      .filter((file) => projects.some((project) => isInside(file, project)));
    expect(trespassing).toEqual([]);
  });

  test('the sweep runs every other test file', () => {
    const projects = standaloneProjects();
    const expected = testFiles()
      .filter((file) => !projects.some((project) => isInside(file, project)));
    expect(sweptFiles()).toEqual(expected);
  });

  test('each unlinked project is checked by a script of its own', () => {
    const checked = directoriesCheckedBy('check:packages');
    for (const project of standaloneProjects()) {
      expect({ project, checked: checked.includes(project) }).toEqual({ project, checked: true });
    }
  });

  test('CI runs both the root check and the per-project checks', () => {
    const run = scriptsRunByCi();
    expect(run).toContain('check');
    expect(run).toContain('check:packages');
  });

  test('the root check is what runs the sweep', () => {
    expect(root.scripts?.check ?? '').toContain('bun run test');
  });
});
