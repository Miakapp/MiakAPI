import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { mutateContexts } from '../src/contexts.js';
import { EXIT_CODE } from '../src/errors.js';
import { run } from '../src/main.js';
import { TOOLS, buildArgv, inputSchema } from '../src/mcp.js';
import { STARTER_ASSETS, STARTER_FILES, starterAssetPath } from '../src/starter.js';
import { CLI_VERSION } from '../src/version.js';
import { homeKey } from './support/control-plane.js';
import { MemoryFiles, PROJECT_ROOT, testHost } from './support/host.js';

const REPOSITORY = resolve(import.meta.dir, '../../..');
const TSC = join(REPOSITORY, 'node_modules/.bin/tsc');
const TARGET = ['--home', 'demo-home', '--control-plane', 'https://control.example.test'];

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miakapp-starter-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function listing(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

async function initStarter(extra: readonly string[] = [], root = directory) {
  const host = testHost({ cwd: root });
  const code = await run(['init', '--starter', 'app', ...TARGET, '--json', ...extra], host);
  return { code, host };
}

describe('init without --starter is unchanged', () => {
  test('it writes the manifest and nothing else', async () => {
    const files = new MemoryFiles();
    const host = testHost({ files });
    expect(await run(['init', ...TARGET, '--json'], host)).toBe(EXIT_CODE.success);
    expect([...files.entries.keys()]).toEqual([`${PROJECT_ROOT}/miakapp.yaml`]);
    expect(files.directories.size).toBe(0);
    expect(host.json()['starter']).toBeNull();
  });
});

describe('init --starter app', () => {
  test('writes the complete starter and a manifest check accepts', async () => {
    const { code, host } = await initStarter();
    expect(code).toBe(EXIT_CODE.success);
    expect(await listing(directory)).toEqual([...STARTER_FILES, 'miakapp.yaml'].sort());
    expect(host.json()).toMatchObject({ kind: 'app', starter: 'app', artifact: 'dist/app.js', release: '0.1.0' });

    const manifest = await readFile(join(directory, 'miakapp.yaml'), 'utf8');
    expect(manifest).toContain('home: demo-home\ncontrol_plane: https://control.example.test\n');
    expect(manifest).toContain('    state_read: []\n    call: []\n');

    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      dependencies?: unknown;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts['build']).toBe('bun build app/main.ts --format=iife --minify --outfile dist/app.js');
    // Only published packages, pinned: no source repository, no unpublished SDK.
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toEqual({ '@miakapp/cli': CLI_VERSION, typescript: '7.0.2' });
    for (const relative of STARTER_ASSETS) {
      const text = await readFile(join(directory, relative), 'utf8');
      expect([relative, text.includes('file:'), /@miakapp\/(app|component)['"]/.test(text)])
        .toEqual([relative, false, false]);
    }
  });

  test('a custom artifact and release reach both the manifest and the build script', async () => {
    const { code } = await initStarter(['--artifact', 'build/house.js', '--release', '2026-10-03.1']);
    expect(code).toBe(EXIT_CODE.success);
    const manifest = await readFile(join(directory, 'miakapp.yaml'), 'utf8');
    expect(manifest).toContain('  artifact: build/house.js\n  release: 2026-10-03.1\n');
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toEndWith('--outfile build/house.js');
  });

  test('home and issuer come from the selected context', async () => {
    const store = join(directory, 'store');
    const key = homeKey();
    await mutateContexts(store, (state) => {
      state.contexts.set('cabin', {
        name: 'cabin',
        issuer: 'https://control.example.test/api',
        homeId: 'cabin-home',
        keyId: key.slice(5, 27),
        label: 'test',
        createdAt: new Date().toISOString(),
      });
      state.keys.set('cabin', key);
      state.current = 'cabin';
    });
    const project = join(directory, 'project');
    await mkdir(project);
    const host = testHost({ cwd: project, env: { MIAKAPP_CONFIG_DIR: store } });
    expect(await run(['init', '--starter', 'app', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({ home_id: 'cabin-home', context: 'cabin' });
    expect(await readFile(join(project, 'miakapp.yaml'), 'utf8'))
      .toContain('home: cabin-home\ncontrol_plane: https://control.example.test/api\n');
    expect(JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))['name']).toBe('miakapp-home-cabin-home');
  });

  for (const existing of [...STARTER_FILES, 'miakapp.yaml']) {
    test(`an existing ${existing} refuses the whole starter and writes nothing`, async () => {
      await mkdir(join(directory, 'app'), { recursive: true });
      await writeFile(join(directory, existing), 'owner bytes\n');
      const before = await listing(directory);

      const { code, host } = await initStarter();
      expect(code).toBe(EXIT_CODE.project);
      expect(host.stderr()).toContain(`${existing} already exists; nothing was written`);
      expect(await listing(directory)).toEqual(before);
      expect(await readFile(join(directory, existing), 'utf8')).toBe('owner bytes\n');
    });
  }

  test('every collision is named at once, and no directory is created', async () => {
    const files = new MemoryFiles({
      [`${PROJECT_ROOT}/package.json`]: '{}',
      [`${PROJECT_ROOT}/app/main.ts`]: '// mine',
    });
    const host = testHost({ files });
    expect(await run(['init', '--starter', 'app', ...TARGET], host)).toBe(EXIT_CODE.project);
    expect(host.stderr()).toContain(`${PROJECT_ROOT}/package.json, ${PROJECT_ROOT}/app/main.ts already exist`);
    expect([...files.entries.keys()].sort()).toEqual([`${PROJECT_ROOT}/app/main.ts`, `${PROJECT_ROOT}/package.json`]);
    expect(files.directories.size).toBe(0);
  });

  for (const [label, argv] of [
    ['an unknown starter', ['--starter', 'component']],
    ['a component kind', ['--starter', 'app', '--kind', 'component']],
    ['an artifact needing shell quoting', ['--starter', 'app', '--artifact', 'dist/my app.js']],
    ['an artifact outside the project', ['--starter', 'app', '--artifact', '../app.js']],
    ['an artifact that is a starter file', ['--starter', 'app', '--artifact', 'app/main.ts']],
    ['a non-script artifact', ['--starter', 'app', '--artifact', 'dist/app.mjs']],
  ] as const) {
    test(`${label} is a usage failure that writes nothing`, async () => {
      const host = testHost({ cwd: directory });
      expect(await run(['init', ...TARGET, ...argv], host)).toBe(EXIT_CODE.usage);
      expect(await readdir(directory)).toEqual([]);
    });
  }

  test('help documents the starter and runs nothing', async () => {
    const host = testHost({ cwd: directory });
    expect(await run(['init', '--starter', 'app', '--help'], host)).toBe(EXIT_CODE.success);
    expect(host.stdout()).toContain('--starter app');
    expect(host.stdout()).toContain('Bun >= 1.2.23');
    expect(await readdir(directory)).toEqual([]);
  });

  test('MCP exposes the same option', () => {
    const tool = TOOLS.find((entry) => entry.name === 'miakapp_init');
    expect(tool).toBeDefined();
    expect(Object.keys(inputSchema(tool!)['properties'] as object)).toContain('starter');
    expect(buildArgv(tool!, { starter: 'app' })).toEqual(['init', '--starter', 'app']);
  });
});

describe('the bridge is the canonical SDK', () => {
  test('app/miakapp.ts is byte-identical to packages/app/src/index.ts', async () => {
    const shipped = await readFile(starterAssetPath('app/miakapp.ts'));
    const canonical = await readFile(join(REPOSITORY, 'packages/app/src/index.ts'));
    // If this fails, the @miakapp/app source changed and the starter copy did
    // not: copy it across, so new homes get the bridge the shell expects.
    expect(shipped.equals(canonical)).toBe(true);
  });
});

/** Just enough DOM for the starter: no network, no storage, nothing else. */
class FakeElement {
  children: Array<FakeElement | string> = [];
  className = '';
  constructor(readonly tagName: string) {}
  set textContent(value: string) {
    this.children = [String(value)];
  }
  get textContent(): string {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  append(...nodes: Array<FakeElement | string>): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Array<FakeElement | string>): void {
    this.children = [...nodes];
  }
  find(tag: string): FakeElement[] {
    return this.children.flatMap((child) => (typeof child === 'string'
      ? []
      : [...(child.tagName === tag ? [child] : []), ...child.find(tag)]));
  }
}

function frame(values: Record<string, unknown>, options: { stale?: boolean; locale?: string } = {}) {
  const listeners: Array<(state: unknown) => void> = [];
  let current = { values, stale: options.stale ?? false, revision: 1 };
  let readyCalls = 0;
  const host = {
    abi: 'miakapp.app/1',
    release: '0.1.0',
    home: { id: 'demo-home', name: 'Maison Test' },
    locale: options.locale ?? 'en',
    theme: 'system',
    onThemeChange: () => () => {},
    state: {
      get: (path: string) => current.values[path],
      values: () => current.values,
      get revision() { return current.revision; },
      get stale() { return current.stale; },
      subscribe: (listener: (state: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    },
    can: { read: (path: string) => path in current.values, call: () => false },
    call: async () => { throw new Error('the starter must not call anything'); },
    ready: () => { readyCalls += 1; },
  };
  const document = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    createElement: (tag: string) => new FakeElement(tag),
  };
  return {
    context: { miakapp: host, document },
    body: document.body,
    readyCalls: () => readyCalls,
    push(next: Record<string, unknown>, stale = false) {
      current = { values: next, stale, revision: current.revision + 1 };
      for (const listener of listeners) listener({ values: next, stale, revision: current.revision });
    },
  };
}

describe('the generated starter builds, typechecks, checks and runs', () => {
  let bundle: string;

  beforeEach(async () => {
    expect((await initStarter()).code).toBe(EXIT_CODE.success);
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);
    bundle = await readFile(join(directory, 'dist/app.js'), 'utf8');
  });

  test('strict TypeScript accepts it and miakapp check accepts the artifact', async () => {
    const typecheck = Bun.spawnSync([TSC, '-p', directory], { stdout: 'pipe', stderr: 'pipe' });
    expect(typecheck.stdout.toString() + typecheck.stderr.toString()).toBe('');
    expect(typecheck.exitCode).toBe(0);

    const host = testHost({ cwd: directory });
    expect(await run(['check', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({ abi: 'miakapp.app/1', home_id: 'demo-home' });
  });

  test('with nothing shared it shows an honest empty state and no value', () => {
    const fixture = frame({});
    runInNewContext(bundle, fixture.context);
    expect(fixture.body.textContent).toContain('Maison Test');
    expect(fixture.body.textContent).toContain('Nothing from this home is shared with this interface yet.');
    expect(fixture.body.find('dd')).toEqual([]);
    expect(fixture.readyCalls()).toBe(1);
  });

  test('it shows exactly the shared values, grouped, and marks a stale view', () => {
    const fixture = frame({
      'climate.salon.temperature': 25.3,
      'climate.entree.temperature': null,
      'zone.salon.light.on': true,
    }, { locale: 'fr' });
    runInNewContext(bundle, fixture.context);
    expect(fixture.body.find('h2').map((node) => node.textContent)).toEqual(['climate', 'zone']);
    expect(fixture.body.find('dd').map((node) => node.textContent)).toEqual(['—', '25,3', 'Oui']);

    fixture.push({ 'climate.salon.temperature': 24.1 }, true);
    expect(fixture.body.textContent).toContain('Dernières valeurs connues ; en attente de la maison.');
    expect(fixture.body.find('dd').map((node) => node.textContent)).toEqual(['24,1']);
    expect(fixture.body.find('section')[0]?.className).toBe('stale');
  });

  test('outside a Miakapp frame it fails loudly instead of rendering an empty home', () => {
    const fixture = frame({});
    expect(() => runInNewContext(bundle, { document: fixture.context.document }))
      .toThrow(/window\.miakapp is missing/);
  });
});

describe('the docs send a new agent through the starter', () => {
  test('the bundled guide and the CLI README name the starter and never an unpublished import', async () => {
    const guide = await readFile(join(import.meta.dir, '../assets/agent-guide.md'), 'utf8');
    const readme = await readFile(join(import.meta.dir, '../README.md'), 'utf8');
    for (const [name, text] of [['guide', guide], ['README', readme]] as const) {
      expect([name, text.includes('init --starter app')]).toEqual([name, true]);
      expect([name, text.includes('app/miakapp.ts')]).toEqual([name, true]);
      expect([name, /from '@miakapp\/app'/.test(text)]).toEqual([name, false]);
    }
    expect(guide).toContain('optional developer');
  });
});
