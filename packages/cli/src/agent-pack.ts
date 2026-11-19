/**
 * The installable pack.
 *
 * A coding agent handed someone's house does not arrive knowing how a Miakapp
 * home is built. It arrives in the owner's repository, with whatever files are
 * already there. This command puts three things in that repository:
 *
 * - the guide and the skills (one per job, for Claude Code and Codex), as
 *   files, so the knowledge survives without a network;
 * - a pointer to it in the instruction file each client actually reads —
 *   `AGENTS.md` for Codex, `CLAUDE.md` for Claude Code;
 * - the MCP server entry, so the tools are wired rather than described.
 *
 * The repository belongs to the owner, and the CLI's rule that it never
 * rewrites what it did not generate holds here too. That rule is what shapes
 * every merge below: the guide and the skills are files this command owns outright, the
 * instruction files are edited only between markers this command wrote, and
 * `.mcp.json` is edited as a structure — one key, by name — never as text.
 * Bytes outside those regions are copied through untouched.
 */
import { projectError } from './errors.js';
import { CLI_VERSION, PACKAGE_NAME } from './version.js';

/** Directory the pack owns inside the owner's repository. */
export const PACK_DIRECTORY = '.miakapp';

/** The guide, copied out of the package so it is readable offline. */
export const GUIDE_FILE = `${PACK_DIRECTORY}/agent-guide.md`;

/** Project-scope MCP configuration. Claude Code reads this file by name. */
export const MCP_FILE = '.mcp.json';

/** The name the server is registered under, and the tool-name prefix. */
export const SERVER_NAME = 'miakapp';

/**
 * Instruction files, by the client that reads each one. Both are written:
 * a repository is handed to whichever agent the owner has, and an unused
 * pointer costs a paragraph.
 */
export const INSTRUCTION_FILES: readonly { readonly path: string; readonly client: string }[] = [
  { path: 'AGENTS.md', client: 'Codex' },
  { path: 'CLAUDE.md', client: 'Claude Code' },
];

/**
 * Where each client discovers repository skills. Both are written, like the
 * instruction files: the owner may hand the repository to either agent.
 */
export const SKILL_ROOTS: readonly { readonly directory: string; readonly client: string }[] = [
  { directory: '.claude/skills', client: 'Claude Code' },
  { directory: '.agents/skills', client: 'Codex' },
];

/** One skill the pack owns: `<root>/<name>/SKILL.md`, rewritten on every run. */
export interface PackSkill {
  readonly name: string;
  readonly content: string;
}

export const BEGIN_MARKER = '<!-- miakapp:begin -->';
export const END_MARKER = '<!-- miakapp:end -->';

/** What happened to one file, reported per file rather than summed. */
export type PackAction = 'created' | 'updated' | 'unchanged';

export interface PackedFile {
  readonly path: string;
  readonly action: PackAction;
}

export interface FileStore {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  replace(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  makeDirectory(path: string): Promise<void>;
}

const encoder = new TextEncoder();

function decode(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw projectError(
      `${path} is not readable as UTF-8 text`,
      'The pack edits text files in place; move this one aside and run the command again.',
    );
  }
}

/**
 * Writes `bytes` at `path`, creating or replacing.
 *
 * Returns `unchanged` when the bytes already on disk are identical, so a second
 * run of the pack reports honestly instead of claiming work it did not do.
 */
export async function put(
  files: FileStore,
  path: string,
  content: string,
): Promise<PackedFile> {
  const bytes = encoder.encode(content);
  if (!await files.exists(path)) {
    await files.write(path, bytes);
    return { path, action: 'created' };
  }
  if (decode(await files.read(path), path) === content) return { path, action: 'unchanged' };
  await files.replace(path, bytes);
  return { path, action: 'updated' };
}

/**
 * The block written into each instruction file.
 *
 * Short on purpose: the guide and the skills carry the knowledge, and a summary
 * that drifts from them is worse than none. The skills are listed here because
 * a client that does not discover repository skills still reads this file.
 */
export function instructionBlock(client: string, skills: readonly string[] = []): string {
  const skillLines = skills.length === 0
    ? ''
    : `\nSkills, one per job — read the one that matches the task:
${skills.map((name) => `\`${name}\``).join(', ')}.
They are in \`${SKILL_ROOTS.map((entry) => entry.directory).join('/` and `')}/\`.\n`;
  return `${BEGIN_MARKER}
## Miakapp

This repository is a Miakapp home: a coordinator on the owner's machine owns
state, events and authorization; an app, published as one bundle, owns only
what residents see.

**Read \`${GUIDE_FILE}\` before changing or publishing anything here.**
${skillLines}
The \`${SERVER_NAME}\` MCP server in \`${MCP_FILE}\` gives ${client} the same commands as the
\`${SERVER_NAME}\` CLI. Done means published and checked on the real home
(\`${SERVER_NAME} taps\`), with the owner holding the \`home_url\`. Never retry an
\`unknown_outcome\`; never put a key in this repository. When a command says a
newer Miakapp is available, follow the \`miakapp-update\` skill.

Generated by \`${SERVER_NAME} agent-pack\` / \`${SERVER_NAME} update\`: edit outside the markers.
${END_MARKER}`;
}

/**
 * Merges the block into an instruction file.
 *
 * Three cases, and the owner's prose survives all three: no file, a file with
 * no block, and a file with a block from an earlier run. The block is appended
 * rather than prepended because the top of an instruction file is where the
 * owner put what matters to them.
 */
export function mergeInstructions(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === '') return `${block}\n`;

  const start = existing.indexOf(BEGIN_MARKER);
  if (start === -1) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${separator}${block}\n`;
  }

  const end = existing.indexOf(END_MARKER, start);
  if (end === -1) {
    throw projectError(
      `An unterminated ${BEGIN_MARKER} block is open in this file`,
      `Close it with ${END_MARKER}, or delete the block and run the pack again.`,
    );
  }
  return existing.slice(0, start) + block + existing.slice(end + END_MARKER.length);
}

/**
 * The server entry, as a client expects to find it.
 *
 * An absolute path is wrong: the pack is written into a repository that may be
 * opened on another machine, where a path from this one resolves to nothing.
 * The bare binary name is wrong for the same reason in reverse — it assumes a
 * global install nobody performed, so the server simply fails to start in the
 * repository the pack was meant to equip. Both were observed: a rehearsal in a
 * fresh repository found `command: "miakapp"` unresolvable.
 *
 * `npx` resolves the published package on any machine with Node, installing it
 * on first use. The version is pinned rather than floating because the guide
 * written beside this file is the guide of *this* release: a floating spec
 * would pair one release's prose with another release's tool surface.
 */
export function serverEntry(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', `${PACKAGE_NAME}@${CLI_VERSION}`, 'mcp'],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges the server entry into an existing `.mcp.json`.
 *
 * Parsed and re-serialized rather than patched as text: every other server in
 * the file is carried across by name, and a file that does not parse is refused
 * instead of being overwritten with a valid one. An owner who hand-edited that
 * file into a syntax error still wants their edit back.
 */
export function mergeMcpConfig(existing: string | undefined): string {
  let document: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      throw projectError(
        `${MCP_FILE} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
        'The pack merges one entry into this file and will not replace it. Fix the JSON first.',
      );
    }
    if (!isPlainObject(parsed)) {
      throw projectError(
        `${MCP_FILE} must hold a JSON object`,
        'The pack merges one entry into this file and will not replace it.',
      );
    }
    document = parsed;
  }

  const servers = document['mcpServers'];
  if (servers !== undefined && !isPlainObject(servers)) {
    throw projectError(
      `${MCP_FILE} has an "mcpServers" key that is not an object`,
      'The pack merges one entry into this file and will not replace it.',
    );
  }

  const merged = { ...(servers ?? {}), [SERVER_NAME]: serverEntry() };
  return `${JSON.stringify({ ...document, mcpServers: merged }, null, 2)}\n`;
}

export interface PackResult {
  readonly root: string;
  readonly files: readonly PackedFile[];
}

/**
 * Installs the pack under `root`.
 *
 * `guide` is passed in rather than read here so the caller decides where the
 * guide comes from: the packaged asset in production, a fixture in a test.
 */
export async function installPack(
  files: FileStore,
  root: string,
  guide: string,
  skills: readonly PackSkill[] = [],
): Promise<PackResult> {
  const written: PackedFile[] = [];

  await files.makeDirectory(`${root}/${PACK_DIRECTORY}`);
  written.push(await put(files, `${root}/${GUIDE_FILE}`, guide));

  // Skills are owned outright, like the guide: the directory names carry the
  // `miakapp-` prefix so they never collide with the owner's own skills.
  for (const { directory } of SKILL_ROOTS) {
    for (const skill of skills) {
      const folder = `${root}/${directory}/${skill.name}`;
      await files.makeDirectory(folder);
      written.push(await put(files, `${folder}/SKILL.md`, skill.content));
    }
  }

  const names = skills.map((skill) => skill.name);
  for (const { path, client } of INSTRUCTION_FILES) {
    const full = `${root}/${path}`;
    const existing = await files.exists(full) ? decode(await files.read(full), full) : undefined;
    written.push(await put(files, full, mergeInstructions(existing, instructionBlock(client, names))));
  }

  const mcpPath = `${root}/${MCP_FILE}`;
  const config = await files.exists(mcpPath) ? decode(await files.read(mcpPath), mcpPath) : undefined;
  written.push(await put(files, mcpPath, mergeMcpConfig(config)));

  return { root, files: written };
}

/**
 * The CLI version a repository's `.mcp.json` pins, if the pack wrote one.
 * Read, never trusted for anything but choosing where a changelog starts.
 */
export function pinnedVersion(mcpConfig: string | undefined): string | undefined {
  if (mcpConfig === undefined) return undefined;
  try {
    const entry = (JSON.parse(mcpConfig) as { mcpServers?: Record<string, { args?: unknown }> })
      .mcpServers?.[SERVER_NAME];
    const args = Array.isArray(entry?.args) ? entry.args : [];
    for (const argument of args) {
      if (typeof argument === 'string' && argument.startsWith(`${PACKAGE_NAME}@`)) {
        const version = argument.slice(PACKAGE_NAME.length + 1);
        return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
      }
    }
  } catch {
    // A broken file pins nothing; installPack reports it properly.
  }
  return undefined;
}

/**
 * Re-pins this package in a `package.json` that already depends on it.
 *
 * Returns `undefined` when there is nothing to do — no dependency on the CLI —
 * because adding one is the owner's decision, not the update's. Only that one
 * key changes; every other key keeps its order and value.
 */
export function mergePackageJson(existing: string, path = 'package.json'): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(existing);
  } catch (error) {
    throw projectError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      'Fix the JSON, then run the update again.',
    );
  }
  if (!isPlainObject(document)) return undefined;
  let touched = false;
  const updated: Record<string, unknown> = { ...document };
  for (const key of ['dependencies', 'devDependencies']) {
    const section = document[key];
    if (isPlainObject(section) && typeof section[PACKAGE_NAME] === 'string') {
      updated[key] = { ...section, [PACKAGE_NAME]: CLI_VERSION };
      touched = true;
    }
  }
  if (!touched) return undefined;
  const indent = /^\{\s*\n(\s+)"/.exec(existing)?.[1] ?? '  ';
  return `${JSON.stringify(updated, null, indent)}\n`;
}
