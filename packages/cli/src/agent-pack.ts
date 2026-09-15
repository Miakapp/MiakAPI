/**
 * The installable pack.
 *
 * A coding agent handed someone's house does not arrive knowing how a Miakapp
 * home is built. It arrives in the owner's repository, with whatever files are
 * already there. This command puts three things in that repository:
 *
 * - the guide, as a file, so the knowledge survives without a network;
 * - a pointer to it in the instruction file each client actually reads —
 *   `AGENTS.md` for Codex, `CLAUDE.md` for Claude Code;
 * - the MCP server entry, so the tools are wired rather than described.
 *
 * The repository belongs to the owner, and the CLI's rule that it never
 * rewrites what it did not generate holds here too. That rule is what shapes
 * every merge below: the guide is a file this command owns outright, the
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
async function put(
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
 * It is short on purpose. Everything an agent needs to know is in the guide,
 * and a summary that drifts from the guide is worse than no summary: the agent
 * would believe the stale copy it read first.
 */
export function instructionBlock(client: string): string {
  return `${BEGIN_MARKER}
## Miakapp

This repository is a Miakapp home: a coordinator that runs on the owner's
machine and owns state, events and authorization, and a component that runs
sandboxed in the household's browser and owns nothing but the interface.

**Read \`${GUIDE_FILE}\` before writing or publishing anything here.** It is the
full guide, copied into this repository so it is readable offline, and it is the
source of truth for the rules below.

The \`${SERVER_NAME}\` MCP server in \`${MCP_FILE}\` exposes the toolchain to ${client}:
inventory an existing installation, validate the project, publish, and roll back.
The same commands exist as \`${SERVER_NAME}\` on the command line; they are one
implementation, so neither surface can drift from the other.

Three rules the guide explains and this file repeats because getting them wrong
is expensive:

- \`publish\`, \`activate\` and \`rollback\` change what every device in the home
  runs. Over MCP they refuse to act without \`confirm: true\`. Set it when the
  owner asked for that publication, never to get past an error.
- Every failure carries a stable \`kind\`. Branch on it, not on the message.
  \`conflict\` means re-read the pointer; \`unknown_outcome\` means the effect is
  undetermined — reconcile with \`${SERVER_NAME} release\` or \`${SERVER_NAME} upload\`
  before acting again, and never retry it.
- The Home Key lives in \`MIAKAPP_HOME_KEY\` in the environment. No command
  accepts it as an argument, and it belongs in no file in this repository.
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
): Promise<PackResult> {
  const written: PackedFile[] = [];

  await files.makeDirectory(`${root}/${PACK_DIRECTORY}`);
  written.push(await put(files, `${root}/${GUIDE_FILE}`, guide));

  for (const { path, client } of INSTRUCTION_FILES) {
    const full = `${root}/${path}`;
    const existing = await files.exists(full) ? decode(await files.read(full), full) : undefined;
    written.push(await put(files, full, mergeInstructions(existing, instructionBlock(client))));
  }

  const mcpPath = `${root}/${MCP_FILE}`;
  const config = await files.exists(mcpPath) ? decode(await files.read(mcpPath), mcpPath) : undefined;
  written.push(await put(files, mcpPath, mergeMcpConfig(config)));

  return { root, files: written };
}
