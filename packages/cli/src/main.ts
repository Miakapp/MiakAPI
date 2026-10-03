/**
 * Agent-first command surface.
 *
 * The CLI builds, validates, publishes and rolls back one home component. Git
 * stays the user's: this tool never writes history, never rewrites sources it
 * did not generate and never invents a control-plane endpoint. Every command is
 * a pure function of the project file, the artifact bytes on disk and the
 * arguments it was given.
 *
 * Two properties matter more than ergonomics here, because the usual caller is
 * a coding agent rather than a person:
 *
 * - one stable exit code and one stable failure kind per outcome (see
 *   {@link EXIT_CODE}), so a wrapper decides without parsing prose;
 * - `--json`, which prints exactly one closed object on stdout.
 */
import { homedir, hostname } from 'node:os';
import { installPack } from './agent-pack.js';
import { CLI_VERSION } from './version.js';
import { prepareArtifact, type Artifact } from './artifact.js';
import { exchangePublisherToken, fetchDiscovery, homeKeyId, homeUrl } from './control-plane.js';
import {
  configDirectory,
  contextNameError,
  isContextName,
  mutateContexts,
  readContexts,
  readCredential,
  type StoredContext,
} from './contexts.js';
import { discoverFlows, inventoryJson, type Inventory } from './discovery.js';
import {
  CliError,
  EXIT_CODE,
  artifactError,
  authorizationError,
  contractError,
  projectError,
  usageError,
} from './errors.js';
import type { FetchLike } from './internal/http.js';
import { isDigest, isRelease, REQUIREMENT_KINDS, type Requirements } from './internal/names.js';
import {
  DEFAULT_ISSUER,
  PAIRING_PAGE,
  normalizeCode,
  pairingIssuer,
  redeemPairingCode,
  validateLabel,
} from './pairing.js';
import { PROJECT_FILE, PROJECT_SCHEMA, findProjectFile, parseProject, type Project } from './project.js';
import {
  activateRelease,
  publish,
  readPointer,
  readRelease,
  readUpload,
  type ComponentPointer,
  type PublicationTarget,
} from './publication.js';

export { CLI_VERSION };

/**
 * A Home Key comes from a paired context in `~/.miakapp` or, for CI and
 * compatibility, from this variable. A secret passed as an argument would land
 * in shell history, in a process listing and in most CI logs, so no command
 * accepts one.
 */
export const HOME_KEY_VARIABLE = 'MIAKAPP_HOME_KEY';

/** Selects a stored context for one invocation, like `--context`. */
export const CONTEXT_VARIABLE = 'MIAKAPP_CONTEXT';

export interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  /** Creates. Fails if the path exists: no command may clobber by accident. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Creates or overwrites.
   *
   * Separate from {@link FileSystem.write} so overwriting is never the default
   * a command falls into. Only `agent-pack` calls it, and only after merging
   * the existing bytes, so what it replaces is a file it generated.
   */
  replace(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Creates the directory and its parents. Succeeds if it already exists. */
  makeDirectory(path: string): Promise<void>;
}

export interface CliHost {
  write(text: string): void;
  writeError(text: string): void;
  cwd(): string;
  env(name: string): string | undefined;
  /** Injected by tests; defaults to `node:fs/promises`. */
  files?: FileSystem;
  /** Injected by tests; defaults to the platform `fetch`. */
  fetch?: FetchLike;
  /** Read only by `mcp`, which serves a request stream instead of one command. */
  input?: AsyncIterable<Uint8Array>;
  /** Parent of `.miakapp`. Injected by tests; defaults to the account's home. */
  homeDirectory?(): string;
  /** Names the machine in a default key label. Defaults to the OS host name. */
  hostname?(): string;
  /**
   * Reads one secret line without echoing it: a hidden prompt on a terminal,
   * the first line of a pipe otherwise. Absent under MCP, whose stdin is the
   * protocol stream.
   */
  readSecret?(prompt: string): Promise<string>;
}

type Field = readonly [key: string, value: string | number | readonly string[]];

export interface CommandResult {
  readonly summary: string;
  readonly fields: readonly Field[];
  readonly json: Record<string, unknown>;
  /** Complete human-facing document for commands such as `docs start`. */
  readonly text?: string;
}

export interface Invocation {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positional: readonly string[];
}

const USAGE = `miakapp ${CLI_VERSION} — build, publish and roll back a Miakapp home interface

Usage
  miakapp <command> [options]

Commands
  docs start              Print the complete agent guide bundled with this CLI
  pair                    Redeem a one-time pairing code into a stored context
  context list            List stored contexts (never prints a key)
  context show [name]     Show one context, the current one by default
  context use <name>      Make a context current
  context remove <name>   Delete a context and its stored key
  init                    Write ${PROJECT_FILE} in the current directory
  agent-pack              Install the guide and the MCP wiring into a repository
  discover                Inventory an existing Node-RED installation offline
  check                   Validate the project and the artifact offline
  status                  Read the live generation and release of the home
  publish                 Upload, finalize and activate the built artifact
  activate                Activate an already finalized digest at a new generation
  rollback                Alias of activate, for returning to a known-good digest
  release <sha256>        Read one finalized release record
  upload <uploadId>       Read one upload status, to reconcile a lost request
  mcp                     Serve these commands over MCP on stdio
  help                    Print this text
  version                 Print the CLI version

Common options
  --help, -h              Print this guide without running the command
  --json                  Print one machine-readable object on stdout
  --project <dir>         Start the ${PROJECT_FILE} search here (default: cwd)
  --context <name>        Use this stored context (status, publish, activate,
                          rollback, release, upload, init)

pair options
  (code)                      Read from stdin: hidden prompt on a terminal, first
                              line of a pipe otherwise. Preferred: never echoed.
  --code <code>               Pass the code explicitly (lands in shell history)
  --issuer <https url>        Control plane to redeem at (default: ${DEFAULT_ISSUER})
  --label <label>             Key label shown to the owner (default: miakapp-cli@host)
  --name <context>            Context name (default: the paired home ID)

publish options
  --expected-generation <n>   Generation the pointer holds (default: read live)
  --generation <n>            Generation to publish (default: expected + 1)
  --release <name>            Override app.release or component.release from ${PROJECT_FILE}

activate / rollback options
  --sha256 <digest>           Finalized artifact digest (required)
  --expected-generation <n>   Generation the pointer holds (default: read live)
  --generation <n>            Generation to publish (default: expected + 1)

discover options
  --flows <path>              Node-RED flows export to read (required)

mcp options
  (none)                      Reads JSON-RPC on stdin, writes it on stdout. Every
                              command above becomes one tool; publish, activate
                              and rollback additionally require confirm: true.

agent-pack options
  --dir <path>                Repository to install into (default: cwd)

init options
  --home <homeId>             Home ID (default: from the selected context)
  --control-plane <https url> Control-plane issuer (default: from the context)
  --kind <app|component>      Interface kind (default: app)
  --artifact <path>           Built artifact path (default: dist/app.js for app,
                              dist/component.js for component)
  --release <name>            Initial release name (default: 0.1.0)

Credentials, highest precedence first
  1. --context <name>       a context stored by miakapp pair
  2. ${CONTEXT_VARIABLE}=<name>  the same, from the environment
  3. ${HOME_KEY_VARIABLE}      a raw Home Key, for CI and compatibility
  4. the stored context whose home and issuer match ${PROJECT_FILE}
     (the current context wins a tie)
  A stored context whose home or issuer differs from ${PROJECT_FILE} is refused,
  so a key can never publish into another home. Keys are never printed.

Environment
  MIAKAPP_CONFIG_DIR   Absolute directory replacing ~/.miakapp

Exit codes
  0 success        1 usage        2 project      3 artifact
  4 authorization  5 contract     6 conflict     7 unknown outcome
`;

const GLOBAL_FLAGS = ['json', 'help'] as const;
const GLOBAL_OPTIONS = ['project'] as const;

/** Exported so the MCP surface can be proved to expose every option, and no other. */
export const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  docs: [],
  pair: ['code', 'issuer', 'label', 'name'],
  context: [],
  init: ['home', 'control-plane', 'artifact', 'release', 'context', 'kind'],
  'agent-pack': ['dir'],
  discover: ['flows'],
  check: [],
  status: ['context'],
  publish: ['expected-generation', 'generation', 'release', 'context'],
  activate: ['sha256', 'expected-generation', 'generation', 'context'],
  rollback: ['sha256', 'expected-generation', 'generation', 'context'],
  release: ['context'],
  upload: ['context'],
  mcp: [],
  help: [],
  version: [],
};

/**
 * Parses `--name value`, `--name=value` and bare flags.
 *
 * Options are a closed set per command: an unrecognized one is a usage error
 * rather than a silently ignored argument, so a mistyped flag can never turn a
 * publication into a different publication.
 */
export function parseArguments(argv: readonly string[]): Invocation {
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h') {
    return { command: 'help', options: new Map(), flags: new Set(), positional: [] };
  }
  if (first === '--version' || first === '-v') {
    return { command: 'version', options: new Map(), flags: new Set(), positional: [] };
  }
  if (first.startsWith('-')) throw usageError(`Expected a command, received ${first}`);

  const command = first;
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) {
    throw usageError(`Unknown command: ${command}`, 'Run miakapp help for the command list.');
  }

  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '-h') {
      flags.add('help');
      continue;
    }
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    if (name === '') throw usageError('Encountered a bare -- separator');
    if ((GLOBAL_FLAGS as readonly string[]).includes(name)) {
      if (separator !== -1) throw usageError(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    const known = (GLOBAL_OPTIONS as readonly string[]).includes(name) || allowed.includes(name);
    if (!known) {
      throw usageError(
        `Unknown option --${name} for ${command}`,
        'Run miakapp help for the options this command accepts.',
      );
    }
    if (options.has(name)) throw usageError(`--${name} was given twice`);
    if (separator !== -1) {
      options.set(name, argument.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw usageError(`--${name} requires a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return { command: flags.has('help') ? 'help' : command, options, flags, positional };
}

function requiredOption(invocation: Invocation, name: string): string {
  const value = invocation.options.get(name);
  if (value === undefined || value === '') throw usageError(`--${name} is required`);
  return value;
}

function generationOption(invocation: Invocation, name: string): number {
  const raw = requiredOption(invocation, name);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw usageError(`--${name} must be a decimal non-negative integer, received ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw usageError(`--${name} is above the safe integer range`);
  return value;
}

interface GenerationPlan {
  readonly expectedGeneration: number | undefined;
  readonly generation: number | undefined;
}

/** Validated before any network use, so a typo never costs a request. */
function generationPlan(invocation: Invocation): GenerationPlan {
  const expectedGeneration = invocation.options.has('expected-generation')
    ? generationOption(invocation, 'expected-generation')
    : undefined;
  const generation = invocation.options.has('generation')
    ? generationOption(invocation, 'generation')
    : undefined;
  if (expectedGeneration !== undefined && generation !== undefined
    && generation <= expectedGeneration) {
    throw usageError('--generation must be strictly above --expected-generation');
  }
  return { expectedGeneration, generation };
}

/**
 * Resolves the compare-and-set pair. Without `--expected-generation` the live
 * generation is read first. That read takes no lock: the activation is still a
 * compare-and-set, so a publication that lands in between fails with
 * `conflict` rather than being overwritten.
 */
async function resolveGenerations(
  target: PublicationTarget,
  plan: GenerationPlan,
): Promise<{ expectedGeneration: number; generation: number }> {
  const expectedGeneration = plan.expectedGeneration ?? (await readPointer(target)).generation;
  const generation = plan.generation ?? expectedGeneration + 1;
  if (generation <= expectedGeneration) {
    throw usageError(
      `--generation must be strictly above the live generation ${expectedGeneration}`,
    );
  }
  return { expectedGeneration, generation };
}

function digestOption(invocation: Invocation, name: string): string {
  const value = requiredOption(invocation, name);
  if (!isDigest(value)) {
    throw usageError(`--${name} must be a SHA-256 digest as 43 base64url characters`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function storeDirectory(host: CliHost): string {
  return configDirectory((name) => host.env(name), host.homeDirectory?.() ?? homedir());
}

/** Where the Home Key of one invocation came from. The key itself never leaves. */
interface Credential {
  readonly homeKey: string;
  readonly source: 'context' | 'environment';
  readonly context: StoredContext | undefined;
}

/** The context named for this invocation, by flag first and then environment. */
function explicitContext(host: CliHost, invocation: Invocation): string | undefined {
  const name = invocation.options.get('context') ?? nonEmpty(host.env(CONTEXT_VARIABLE));
  if (name !== undefined && !isContextName(name)) contextNameError(name);
  return name;
}

/**
 * The wrong-home guard. The project file says where a publication goes; a
 * context says which home its key opens. When the two disagree the command
 * stops, because the control plane would accept a valid key for home A
 * publishing into home A, while the person meant home B.
 */
function requireSameHome(context: StoredContext, project: Project, origin: string): void {
  if (context.homeId === project.homeId && context.issuer === project.issuer) return;
  throw authorizationError(
    `${origin} is for home ${context.homeId} at ${context.issuer}, but ${PROJECT_FILE} targets `
    + `home ${project.homeId} at ${project.issuer}`,
    'Select the context paired with this home (miakapp context list), or pair it with '
    + 'miakapp pair. Nothing was sent.',
  );
}

/**
 * Picks the Home Key for one invocation. Precedence, highest first:
 *
 * 1. `--context <name>`, then `MIAKAPP_CONTEXT`: an explicit stored context;
 * 2. `MIAKAPP_HOME_KEY`: a raw key, for CI and compatibility;
 * 3. the stored context paired with the project's home and issuer, the
 *    current context breaking a tie between several keys for that one home.
 *
 * A stored context is used only for the home it was paired with, and a raw
 * key known to belong to another stored home is refused the same way.
 */
async function resolveCredential(
  host: CliHost,
  invocation: Invocation,
  project: Project,
): Promise<Credential> {
  const directory = storeDirectory(host);
  const explicit = explicitContext(host, invocation);
  if (explicit !== undefined) {
    const { context, homeKey } = await readCredential(directory, explicit);
    requireSameHome(context, project, `Context ${context.name}`);
    return { homeKey, source: 'context', context };
  }

  const environmentKey = nonEmpty(host.env(HOME_KEY_VARIABLE));
  if (environmentKey !== undefined) {
    const keyId = homeKeyId(environmentKey);
    let known: Iterable<StoredContext> = [];
    try {
      known = (await readContexts(directory)).contexts.values();
    } catch {
      // The guard is best effort here: a CI runner has no store, and a broken
      // one must not block a key the caller supplied explicitly.
    }
    for (const context of known) {
      if (context.keyId === keyId) {
        requireSameHome(context, project, `${HOME_KEY_VARIABLE} (paired as context ${context.name})`);
      }
    }
    return { homeKey: environmentKey, source: 'environment', context: undefined };
  }

  const state = await readContexts(directory);
  const matching = [...state.contexts.values()]
    .filter((context) => context.homeId === project.homeId && context.issuer === project.issuer)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const chosen = matching.find((context) => context.name === state.current) ?? matching[0];
  if (chosen === undefined) {
    const others = [...state.contexts.keys()];
    throw authorizationError(
      `No credential for home ${project.homeId} at ${project.issuer}`,
      'Pair this home: ask the owner to open '
      + `${PAIRING_PAGE}, choose it, confirm access and send you the code, then run `
      + `miakapp pair. ${HOME_KEY_VARIABLE} also works, for CI.`
      + (others.length === 0 ? '' : ` Stored contexts are for other homes: ${others.join(', ')}.`),
    );
  }
  const { homeKey } = await readCredential(directory, chosen.name);
  return { homeKey, source: 'context', context: chosen };
}

function credentialJson(credential: Credential): Record<string, unknown> {
  return {
    credential_source: credential.source,
    context: credential.context?.name ?? null,
  };
}

function credentialFields(credential: Credential): readonly Field[] {
  return [[
    'credential',
    credential.context === undefined ? HOME_KEY_VARIABLE : `context ${credential.context.name}`,
  ]];
}

async function nodeFileSystem(): Promise<FileSystem> {
  const fs = await import('node:fs/promises');
  return {
    async read(path) {
      return new Uint8Array(await fs.readFile(path));
    },
    async write(path, bytes) {
      await fs.writeFile(path, bytes, { flag: 'wx' });
    },
    async replace(path, bytes) {
      await fs.writeFile(path, bytes);
    },
    async makeDirectory(path) {
      await fs.mkdir(path, { recursive: true });
    },
    async exists(path) {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function files(host: CliHost): Promise<FileSystem> {
  return host.files ?? await nodeFileSystem();
}

async function loadProject(host: CliHost, invocation: Invocation): Promise<Project> {
  const filesystem = await files(host);
  const start = invocation.options.get('project') ?? host.cwd();
  const path = await findProjectFile(start, (candidate) => filesystem.exists(candidate));
  const root = path.slice(0, path.length - PROJECT_FILE.length - 1);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(await filesystem.read(path));
  } catch {
    throw projectError(`${path} is not readable as UTF-8 text`);
  }
  return parseProject(root, source);
}

async function loadArtifact(host: CliHost, project: Project): Promise<Artifact> {
  const filesystem = await files(host);
  if (!await filesystem.exists(project.artifactPath)) {
    throw artifactError(
      `No artifact at ${project.artifactPath}`,
      'Build the component before publishing; the CLI never bundles sources itself.',
    );
  }
  return prepareArtifact(await filesystem.read(project.artifactPath));
}

async function publicationTarget(
  host: CliHost,
  invocation: Invocation,
  project: Project,
): Promise<{ target: PublicationTarget; credential: Credential; homeUrl: string | null }> {
  const credential = await resolveCredential(host, invocation, project);
  const options = host.fetch === undefined ? {} : { fetch: host.fetch };
  const discovery = await fetchDiscovery({ issuer: project.issuer, ...options });
  const token = await exchangePublisherToken(discovery, credential.homeKey, options);
  return {
    target: { issuer: discovery.issuer, homeId: project.homeId, token: token.accessToken, ...options },
    credential,
    homeUrl: homeUrl(discovery, project.homeId),
  };
}

function requirementFields(requires: Requirements): readonly Field[] {
  return REQUIREMENT_KINDS.map((kind): Field => [`requires.${kind}`, requires[kind]]);
}

/**
 * `home_url` is the link residents open — the trusted Miakapp shell for this
 * home, from discovery — and the only link to hand a person. `url` stays the
 * raw artifact the shell verifies and runs; it is printed as `artifact_url` so
 * it is never mistaken for a page.
 */
function pointerResult(
  summary: string,
  pointer: ComponentPointer,
  credential: Credential,
  expectedGeneration: number | undefined,
  residentUrl: string | null,
): CommandResult {
  return {
    summary,
    fields: [
      ...credentialFields(credential),
      ...(expectedGeneration === undefined
        ? []
        : [['expected_generation', expectedGeneration] as Field]),
      ['home', pointer.homeId],
      ['home_url', residentUrl ?? 'not advertised by this control plane'],
      ['abi', pointer.abi],
      ['generation', pointer.generation],
      ['release', pointer.release],
      ['sha256', pointer.sha256],
      ['size', pointer.size],
      ['artifact_url', pointer.url],
      ...requirementFields(pointer.requires),
    ],
    json: {
      home_id: pointer.homeId,
      home_url: residentUrl,
      generation: pointer.generation,
      release: pointer.release,
      abi: pointer.abi,
      url: pointer.url,
      sha256: pointer.sha256,
      size: pointer.size,
      requires: pointer.requires,
      ...(expectedGeneration === undefined ? {} : { expected_generation: expectedGeneration }),
      ...credentialJson(credential),
    },
  };
}

function projectTemplate(fields: {
  home: string;
  controlPlane: string;
  artifact: string;
  release: string;
  kind: 'app' | 'component';
}): string {
  if (fields.kind === 'app') {
    return `schema: ${PROJECT_SCHEMA}
home: ${fields.home}
control_plane: ${fields.controlPlane}

# A whole-house application: one self-contained classic-script (IIFE) bundle
# that draws its own interface in Miakapp's isolated frame. Every path read and
# every function called must be declared; the coordinator still decides, per
# resident, what each one may see and do.
app:
  artifact: ${fields.artifact}
  release: ${fields.release}
  requires:
    state_read: []
    call: []
`;
  }
  return `schema: ${PROJECT_SCHEMA}
home: ${fields.home}
control_plane: ${fields.controlPlane}

component:
  artifact: ${fields.artifact}
  release: ${fields.release}
  requires:
    state_read: []
    event_subscribe: []
    event_publish: []
    call: []
    presentation: []
`;
}

async function runInit(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const filesystem = await files(host);
  const root = invocation.options.get('project') ?? host.cwd();
  const path = `${root}/${PROJECT_FILE}`;
  if (await filesystem.exists(path)) {
    throw projectError(
      `${path} already exists`,
      'The CLI never overwrites a project file; edit it or remove it first.',
    );
  }
  const release = invocation.options.get('release') ?? '0.1.0';
  if (!isRelease(release)) {
    throw usageError('--release must be 1..64 UTF-8 bytes without control characters');
  }
  const kind = invocation.options.get('kind') ?? 'app';
  if (kind !== 'app' && kind !== 'component') {
    throw usageError('--kind must be app (whole-house application, default) or component');
  }
  const target = await initTarget(host, invocation);
  const source = projectTemplate({
    home: target.home,
    controlPlane: target.controlPlane,
    artifact: invocation.options.get('artifact') ?? (kind === 'app' ? 'dist/app.js' : 'dist/component.js'),
    release,
    kind,
  });
  // Parsed before it is written, so init can never emit a file check rejects.
  parseProject(root, source);
  await filesystem.write(path, new TextEncoder().encode(source));
  return {
    summary: `Wrote ${path}`,
    fields: [
      ['project', path],
      ['home', target.home],
      ['control_plane', target.controlPlane],
      ...(target.context === undefined ? [] : [['context', target.context] as Field]),
    ],
    json: {
      project: path,
      schema: PROJECT_SCHEMA,
      kind,
      home_id: target.home,
      control_plane: target.controlPlane,
      context: target.context ?? null,
    },
  };
}

/**
 * `--home` and `--control-plane` default to the selected context — the one
 * named by `--context` or `MIAKAPP_CONTEXT`, else the current one — so the step
 * after `miakapp pair` needs no identifier typed by hand. An explicit value
 * that contradicts an explicitly selected context is refused rather than
 * silently preferred.
 */
async function initTarget(host: CliHost, invocation: Invocation): Promise<{
  home: string;
  controlPlane: string;
  context: string | undefined;
}> {
  const home = invocation.options.get('home');
  const controlPlane = invocation.options.get('control-plane');
  const explicit = explicitContext(host, invocation);
  if (explicit === undefined && home !== undefined && controlPlane !== undefined) {
    return { home, controlPlane, context: undefined };
  }
  const state = await readContexts(storeDirectory(host));
  const name = explicit ?? state.current ?? undefined;
  const context = name === undefined ? undefined : state.contexts.get(name);
  if (explicit !== undefined && context === undefined) {
    throw usageError(`No context named ${explicit}`, 'Run miakapp context list.');
  }
  if (context === undefined) {
    throw usageError(
      `--${home === undefined ? 'home' : 'control-plane'} is required when no context is selected`,
      'Pair the home first with miakapp pair, or pass both --home and --control-plane.',
    );
  }
  if (explicit !== undefined
    && ((home !== undefined && home !== context.homeId)
      || (controlPlane !== undefined && controlPlane !== context.issuer))) {
    throw usageError(
      `Context ${context.name} is for home ${context.homeId} at ${context.issuer}, which `
      + 'contradicts --home or --control-plane',
    );
  }
  return {
    home: home ?? context.homeId,
    controlPlane: controlPlane ?? context.issuer,
    context: context.name,
  };
}

/**
 * Absolute path of the guide shipped with this package.
 *
 * Resolved from this module rather than from the working directory: the pack is
 * installed into someone else's repository, and the guide has to come from the
 * installed CLI wherever that repository happens to be.
 *
 * Exported so a test reads the same path the command does. A test that seeded a
 * fixture at a path the command never opens would prove nothing.
 */
export async function guideAssetPath(): Promise<string> {
  const { fileURLToPath } = await import('node:url');
  return fileURLToPath(new URL('../assets/agent-guide.md', import.meta.url));
}

/**
 * Gives an agent its complete starting contract without requiring a repository,
 * a network request or an MCP client. The onboarding page can therefore hand a
 * person one stable command and the installed CLI remains the source of truth.
 */
async function runDocs(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  if (invocation.positional.length !== 1 || invocation.positional[0] !== 'start') {
    throw usageError(
      'docs requires the topic start',
      'Run miakapp docs start to print the complete agent guide.',
    );
  }

  const path = await guideAssetPath();
  let guide: string;
  try {
    const filesystem = await files(host);
    guide = new TextDecoder('utf-8', { fatal: true }).decode(await filesystem.read(path));
  } catch {
    throw projectError(
      `The packaged guide is missing or unreadable at ${path}`,
      'Reinstall @miakapp/cli: the guide is bundled with the package and opens no network connection.',
    );
  }

  return {
    summary: 'Miakapp agent guide',
    fields: [],
    json: { topic: 'start', guide },
    text: guide.endsWith('\n') ? guide : `${guide}\n`,
  };
}

/**
 * Installs the agent pack. Like `discover`, it loads no project file: the
 * repository it prepares is usually one that has no V4 project yet.
 */
async function runAgentPack(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const filesystem = await files(host);
  const root = invocation.options.get('dir') ?? host.cwd();
  if (!await filesystem.exists(root)) {
    throw projectError(
      `No directory at ${root}`,
      'Point --dir at the repository to install into, or run the command inside it.',
    );
  }

  const guidePath = await guideAssetPath();
  let guide: string;
  try {
    guide = new TextDecoder('utf-8', { fatal: true }).decode(await filesystem.read(guidePath));
  } catch {
    throw projectError(
      `The packaged guide is missing or unreadable at ${guidePath}`,
      'Reinstall @miakapp/cli: the pack copies the guide out of the package, never off the network.',
    );
  }

  const result = await installPack(filesystem, root, guide);
  const changed = result.files.filter((entry) => entry.action !== 'unchanged').length;
  return {
    summary: changed === 0
      ? `The pack in ${root} is already current`
      : `Installed the agent pack in ${root}`,
    fields: result.files.map((entry) => [entry.path, entry.action] as Field),
    json: {
      root: result.root,
      changed,
      files: result.files.map((entry) => ({ path: entry.path, action: entry.action })),
    },
  };
}

/**
 * Reads an existing installation. `discover` never loads the project file: an
 * agent runs it on a house that has no V4 project yet, which is the whole point
 * of the command.
 */
async function runDiscover(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const path = requiredOption(invocation, 'flows');
  const filesystem = await files(host);
  if (!await filesystem.exists(path)) {
    throw projectError(
      `No flows export at ${path}`,
      'Point --flows at the Node-RED flows.json, or at an Export > All flows download.',
    );
  }
  const inventory = discoverFlows(await filesystem.read(path));
  return {
    summary: discoverSummary(inventory),
    fields: discoverFields(inventory),
    json: inventoryJson(inventory),
  };
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function discoverSummary(inventory: Inventory): string {
  const critical = inventory.findings.filter((item) => item.severity === 'critical').length;
  const census = [
    counted(inventory.nodeCount, 'node', 'nodes'),
    counted(inventory.flows.length, 'flow', 'flows'),
    counted(inventory.brokers.length, 'broker', 'brokers'),
    counted(inventory.state.length, 'state path', 'state paths'),
    counted(inventory.actions.length, 'action', 'actions'),
  ].join(', ');
  return critical === 0
    ? census
    : `${census} — ${counted(critical, 'finding', 'findings')} to settle before migrating`;
}

function discoverFields(inventory: Inventory): readonly Field[] {
  const fields: Field[] = [];
  for (const home of inventory.homes) {
    fields.push([`home.${home.homeId}`, `coordinator ${home.coordinatorId}`]);
  }
  for (const broker of inventory.brokers) {
    const address = broker.port === undefined ? broker.host : `${broker.host}:${broker.port}`;
    fields.push([
      `broker.${broker.name === '' ? broker.id : broker.name}`,
      `${address} tls=${broker.tls} in=${broker.subscribes.length} out=${broker.publishes.length}`,
    ]);
  }
  for (const tab of inventory.flows) {
    fields.push([`flow.${tab.label === '' ? tab.id : tab.label}`, `${tab.nodeCount} nodes`]);
  }
  if (inventory.state.length > 0) {
    fields.push(['state', inventory.state.map((entry) => entry.path)]);
  }
  if (inventory.actions.length > 0) {
    fields.push(['actions', inventory.actions.map((entry) => entry.inputId)]);
  }
  if (inventory.unmodelled.length > 0) {
    fields.push(['unmodelled', inventory.unmodelled.map((entry) => `${entry.type}×${entry.count}`)]);
  }
  for (const item of inventory.findings) {
    fields.push([item.severity, item.detail]);
  }
  return fields;
}

async function runCheck(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const project = await loadProject(host, invocation);
  const artifact = await loadArtifact(host, project);
  const filesystem = await files(host);
  const coordinator = project.coordinatorEntry;
  if (coordinator !== undefined && !await filesystem.exists(coordinator)) {
    throw projectError(`coordinator.entry does not exist: ${coordinator}`);
  }
  return {
    summary: `${project.homeId} release ${project.release} is publishable`,
    fields: [
      ['home', project.homeId],
      ['control_plane', project.issuer],
      ['abi', project.abi],
      ['release', project.release],
      ['artifact', project.artifactPath],
      ['sha256', artifact.sha256],
      ['size', artifact.size],
      ['tokens', artifact.tokens],
      ...requirementFields(project.requires),
    ],
    json: {
      home_id: project.homeId,
      control_plane: project.issuer,
      abi: project.abi,
      release: project.release,
      artifact: project.artifactPath,
      sha256: artifact.sha256,
      size: artifact.size,
      tokens: artifact.tokens,
      requires: project.requires,
    },
  };
}

async function runPublish(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const plan = generationPlan(invocation);
  const project = await loadProject(host, invocation);
  const release = invocation.options.get('release') ?? project.release;
  if (!isRelease(release)) {
    throw usageError('--release must be 1..64 UTF-8 bytes without control characters');
  }
  const artifact = await loadArtifact(host, project);
  const { target, credential, homeUrl: residentUrl } = await publicationTarget(host, invocation, project);
  const { expectedGeneration, generation } = await resolveGenerations(target, plan);
  const { pointer } = await publish(target, artifact, {
    release,
    abi: project.abi,
    requires: project.requires,
    expectedGeneration,
    generation,
  });
  return pointerResult(
    `Published ${release} as generation ${pointer.generation}`,
    pointer,
    credential,
    expectedGeneration,
    residentUrl,
  );
}

async function runActivate(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const sha256 = digestOption(invocation, 'sha256');
  const plan = generationPlan(invocation);
  const project = await loadProject(host, invocation);
  const { target, credential, homeUrl: residentUrl } = await publicationTarget(host, invocation, project);
  // Activation is checked against a readable finalized record first, so a typo
  // in a digest fails as an artifact error instead of spending a CAS attempt.
  const existing = await readRelease(target, sha256);
  if (existing === undefined) {
    throw artifactError(
      `No finalized release for ${sha256}`,
      'Activate only a digest this home has already published.',
    );
  }
  const { expectedGeneration, generation } = await resolveGenerations(target, plan);
  const pointer = await activateRelease(target, { sha256, expectedGeneration, generation });
  return pointerResult(
    `Activated ${existing.release} as generation ${pointer.generation}`,
    pointer,
    credential,
    expectedGeneration,
    residentUrl,
  );
}

async function runRelease(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const sha256 = invocation.positional[0];
  if (sha256 === undefined) throw usageError('release requires one sha256 argument');
  if (!isDigest(sha256)) {
    throw usageError('The release digest must be 43 base64url characters');
  }
  const project = await loadProject(host, invocation);
  const { target } = await publicationTarget(host, invocation, project);
  const record = await readRelease(target, sha256);
  if (record === undefined) {
    throw artifactError(`No finalized release for ${sha256}`);
  }
  return {
    summary: `Release ${record.release} finalized at ${record.finalizedAt}`,
    fields: [
      ['release', record.release],
      ['sha256', record.sha256],
      ['size', record.size],
      ['finalized_at', record.finalizedAt],
      ...requirementFields(record.requires),
    ],
    json: {
      release: record.release,
      abi: record.abi,
      sha256: record.sha256,
      size: record.size,
      requires: record.requires,
      finalized_at: record.finalizedAt,
    },
  };
}

async function runUpload(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const uploadId = invocation.positional[0];
  if (uploadId === undefined) throw usageError('upload requires one uploadId argument');
  const project = await loadProject(host, invocation);
  const { target } = await publicationTarget(host, invocation, project);
  const state = await readUpload(target, uploadId);
  return {
    summary: `Upload ${state.uploadId} is ${state.status}`,
    fields: [
      ['upload_id', state.uploadId],
      ['status', state.status],
      ['release', state.release],
      ['sha256', state.sha256],
      ['size', state.size],
      ['expires_at', state.expiresAt],
    ],
    json: {
      upload_id: state.uploadId,
      status: state.status,
      release: state.release,
      abi: state.abi,
      sha256: state.sha256,
      size: state.size,
      requires: state.requires,
      expires_at: state.expiresAt,
    },
  };
}

async function runStatus(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const project = await loadProject(host, invocation);
  const { target, credential, homeUrl: residentUrl } = await publicationTarget(host, invocation, project);
  const { generation, pointer } = await readPointer(target);
  if (pointer === null) {
    return {
      summary: `${project.homeId} has never activated an interface (generation 0)`,
      fields: [
        ['home', project.homeId],
        ['home_url', residentUrl ?? 'not advertised by this control plane'],
        ['generation', 0],
        ...credentialFields(credential),
      ],
      json: {
        home_id: project.homeId,
        home_url: residentUrl,
        generation,
        active: false,
        ...credentialJson(credential),
      },
    };
  }
  const result = pointerResult(
    `${project.homeId} runs ${pointer.release} at generation ${generation}`,
    pointer,
    credential,
    undefined,
    residentUrl,
  );
  return { ...result, json: { ...result.json, active: true } };
}

function defaultLabel(host: CliHost): string {
  const machine = (host.hostname?.() ?? hostname()).replace(/[^A-Za-z0-9._-]/g, '-');
  return `miakapp-cli@${machine === '' ? 'unknown' : machine}`.slice(0, 64);
}

/** A free context name: the base itself, else base-2, base-3, ... */
function freeContextName(taken: ReadonlyMap<string, unknown>, base: string): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, 62 - String(suffix).length)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function pairingCode(host: CliHost, invocation: Invocation): Promise<string> {
  const explicit = invocation.options.get('code');
  if (explicit !== undefined) return explicit;
  if (host.readSecret === undefined) {
    throw usageError(
      'pair needs the one-time code',
      'Pipe it on stdin (printf %s "$CODE" | miakapp pair) or run miakapp pair in a terminal to '
      + 'be prompted without echo.',
    );
  }
  return await host.readSecret('Pairing code (hidden): ');
}

/**
 * Trades a one-time pairing code for a fresh Home Key and stores it as a new
 * context. Every existing context is kept. The new context becomes current.
 *
 * Everything that can fail without spending the code — the issuer, the label,
 * the name, the readability of the store and the issuer's discovery document —
 * is checked before the code is sent, because a code works exactly once.
 */
async function runPair(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const issuer = pairingIssuer(invocation.options.get('issuer') ?? DEFAULT_ISSUER);
  const label = validateLabel(invocation.options.get('label') ?? defaultLabel(host));
  const requestedName = invocation.options.get('name');
  if (requestedName !== undefined && !isContextName(requestedName)) contextNameError(requestedName);
  const directory = storeDirectory(host);
  const before = await readContexts(directory);
  if (requestedName !== undefined && before.contexts.has(requestedName)) {
    throw usageError(
      `A context named ${requestedName} already exists`,
      `Choose another --name, or remove it first with miakapp context remove ${requestedName}. `
      + 'The code was not used.',
    );
  }

  const code = normalizeCode(await pairingCode(host, invocation));
  const options = host.fetch === undefined ? {} : { fetch: host.fetch };
  let discovery: Awaited<ReturnType<typeof fetchDiscovery>>;
  try {
    discovery = await fetchDiscovery({ issuer, ...options });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown failure';
    throw contractError(
      `${issuer} did not prove it is a Miakapp control plane: ${reason}`,
      'The code was not sent and is still valid until it expires. Check --issuer and the '
      + 'network, then run pair again with the same code.',
    );
  }
  const paired = await redeemPairingCode({ issuer, code, label, ...options });

  const createdAt = new Date().toISOString();
  let stored: { name: string; previous: readonly StoredContext[] };
  try {
    stored = await mutateContexts(directory, (state) => {
      const previous = [...state.contexts.values()]
        .filter((context) => context.homeId === paired.homeId && context.issuer === paired.issuer);
      const name = freeContextName(state.contexts, requestedName ?? paired.homeId);
      state.contexts.set(name, {
        name,
        issuer: paired.issuer,
        homeId: paired.homeId,
        keyId: paired.keyId,
        label,
        createdAt,
      });
      state.keys.set(name, paired.homeKey);
      state.current = name;
      return { name, previous };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown failure';
    throw authorizationError(
      `Home Key ${paired.keyId} for ${paired.homeId} was issued but could not be stored in `
      + `${directory}: ${reason}`,
      `Ask the owner to revoke the key labelled ${JSON.stringify(label)}, fix the directory, then pair again.`,
    );
  }

  // The key is stored; proving it can obtain a publication token tells the
  // agent now, rather than at its first publish, whether the grant is usable.
  let publishAccess: 'verified' | 'refused' = 'verified';
  let publishAccessDetail: string | undefined;
  try {
    await exchangePublisherToken(discovery, paired.homeKey, options);
  } catch (error) {
    publishAccess = 'refused';
    publishAccessDetail = error instanceof Error ? error.message : 'unknown failure';
  }

  const previous = stored.previous.map((context) => context.name);
  return {
    summary: `Paired ${paired.homeId} as context ${stored.name}`
      + (publishAccess === 'verified' ? '' : ' (the key could not obtain a publication token)'),
    fields: [
      ['context', stored.name],
      ['home', paired.homeId],
      ['issuer', paired.issuer],
      ['key_id', paired.keyId],
      ['label', label],
      ['current', 'yes'],
      ['publish_access', publishAccessDetail === undefined ? publishAccess : `${publishAccess}: ${publishAccessDetail}`],
      ['config', directory],
      ...(previous.length === 0 ? [] : [['earlier_contexts_for_this_home', previous] as Field]),
    ],
    json: {
      context: stored.name,
      home_id: paired.homeId,
      issuer: paired.issuer,
      key_id: paired.keyId,
      label,
      current: true,
      publish_access: publishAccess,
      ...(publishAccessDetail === undefined ? {} : { publish_access_detail: publishAccessDetail }),
      config_directory: directory,
      earlier_contexts_for_this_home: previous,
    },
  };
}

function contextJson(
  context: StoredContext,
  current: string | null,
  credential: string | undefined,
): Record<string, unknown> {
  return {
    name: context.name,
    home_id: context.homeId,
    issuer: context.issuer,
    key_id: context.keyId,
    label: context.label,
    created_at: context.createdAt,
    current: context.name === current,
    credential: credential ?? 'missing',
  };
}

/**
 * `context list | show [name] | use <name> | remove <name>`.
 *
 * Nothing here prints a Home Key: `credential` reports only whether the stored
 * key is present and is the key the context was paired with.
 */
async function runContext(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const [action, name, extra] = invocation.positional;
  const directory = storeDirectory(host);
  if (extra !== undefined) throw usageError('context takes at most one name');
  const named = (verb: string): string => {
    if (name === undefined) throw usageError(`context ${verb} requires a context name`);
    if (!isContextName(name)) contextNameError(name);
    return name;
  };

  switch (action) {
    case 'list': {
      if (name !== undefined) throw usageError('context list takes no name');
      const state = await readContexts(directory);
      const contexts = [...state.contexts.values()];
      return {
        summary: contexts.length === 0
          ? `No context in ${directory}. Run miakapp pair to add one.`
          : `${counted(contexts.length, 'context', 'contexts')} in ${directory}`,
        fields: contexts.map((context): Field => [
          `${context.name === state.current ? '* ' : ''}${context.name}`,
          `home ${context.homeId} at ${context.issuer}, key ${context.keyId} `
          + `(${state.credentials.get(context.name) ?? 'missing'})`,
        ]),
        json: {
          config_directory: directory,
          current_context: state.current,
          contexts: contexts.map((context) => contextJson(
            context,
            state.current,
            state.credentials.get(context.name),
          )),
        },
      };
    }
    case 'show': {
      const state = await readContexts(directory);
      const selected = name ?? state.current ?? undefined;
      if (selected === undefined) {
        throw usageError('No current context', 'Name one: miakapp context show <name>, or pair with miakapp pair.');
      }
      if (!isContextName(selected)) contextNameError(selected);
      const context = state.contexts.get(selected);
      if (context === undefined) {
        throw usageError(`No context named ${selected}`, 'Run miakapp context list.');
      }
      const json = contextJson(context, state.current, state.credentials.get(context.name));
      return {
        summary: `Context ${context.name}${json['current'] === true ? ' (current)' : ''}`,
        fields: [
          ['home', context.homeId],
          ['issuer', context.issuer],
          ['key_id', context.keyId],
          ['label', context.label],
          ['created_at', context.createdAt],
          ['credential', `${String(json['credential'])} (never printed)`],
          ['config', directory],
        ],
        json: { ...json, config_directory: directory },
      };
    }
    case 'use': {
      const selected = named('use');
      const context = await mutateContexts(directory, (state) => {
        const found = state.contexts.get(selected);
        if (found === undefined) {
          throw usageError(`No context named ${selected}`, 'Run miakapp context list.');
        }
        state.current = selected;
        return found;
      });
      return {
        summary: `Current context is now ${selected}`,
        fields: [['home', context.homeId], ['issuer', context.issuer]],
        json: { current_context: selected, home_id: context.homeId, issuer: context.issuer },
      };
    }
    case 'remove': {
      const selected = named('remove');
      const result = await mutateContexts(directory, (state) => {
        const found = state.contexts.get(selected);
        if (found === undefined) {
          throw usageError(`No context named ${selected}`, 'Run miakapp context list.');
        }
        state.contexts.delete(selected);
        state.keys.delete(selected);
        const wasCurrent = state.current === selected;
        if (wasCurrent) state.current = null;
        return { context: found, wasCurrent };
      });
      return {
        summary: `Removed context ${selected} and its stored key`,
        fields: [
          ['home', result.context.homeId],
          ['key_id', result.context.keyId],
          ['still_valid_on_server', 'yes: ask the owner to revoke it if it is no longer needed'],
        ],
        json: {
          removed: selected,
          home_id: result.context.homeId,
          key_id: result.context.keyId,
          was_current: result.wasCurrent,
          revoked: false,
        },
      };
    }
    default:
      throw usageError(
        action === undefined ? 'context requires an action' : `Unknown context action: ${action}`,
        'Use context list, context show [name], context use <name> or context remove <name>.',
      );
  }
}

/**
 * Runs one parsed invocation.
 *
 * Exported for `mcp`, which reaches the same commands without a process: a
 * tool call and a command line must not be able to diverge.
 */
export async function dispatch(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  switch (invocation.command) {
    case 'docs':
      return await runDocs(host, invocation);
    case 'pair':
      return await runPair(host, invocation);
    case 'context':
      return await runContext(host, invocation);
    case 'status':
      return await runStatus(host, invocation);
    case 'init':
      return await runInit(host, invocation);
    case 'agent-pack':
      return await runAgentPack(host, invocation);
    case 'discover':
      return await runDiscover(host, invocation);
    case 'check':
      return await runCheck(host, invocation);
    case 'publish':
      return await runPublish(host, invocation);
    case 'activate':
    case 'rollback':
      return await runActivate(host, invocation);
    case 'release':
      return await runRelease(host, invocation);
    case 'upload':
      return await runUpload(host, invocation);
    default:
      throw usageError(`Unknown command: ${invocation.command}`);
  }
}

function renderText(result: CommandResult): string {
  if (result.text !== undefined) return result.text;
  const lines = [result.summary];
  for (const [key, value] of result.fields) {
    lines.push(`  ${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : String(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderFailure(error: CliError, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      ok: false,
      kind: error.kind,
      exit_code: error.exitCode,
      message: error.message,
      ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
    })}\n`;
  }
  const remedy = error.remedy === undefined ? '' : `\n  ${error.remedy}`;
  return `miakapp: ${error.kind}: ${error.message}${remedy}\n`;
}

/**
 * Runs one invocation and returns its exit code.
 *
 * Nothing throws out of this function: an unexpected error becomes
 * `unknown_outcome`, because a CLI that crashed mid-publication cannot claim
 * the control plane was left untouched.
 */
export async function run(argv: readonly string[], host: CliHost): Promise<number> {
  let json = false;
  try {
    const invocation = parseArguments(argv);
    json = invocation.flags.has('json');
    if (invocation.command === 'help') {
      host.write(json ? `${JSON.stringify({ ok: true, usage: USAGE })}\n` : USAGE);
      return EXIT_CODE.success;
    }
    if (invocation.command === 'version') {
      host.write(json ? `${JSON.stringify({ ok: true, version: CLI_VERSION })}\n` : `${CLI_VERSION}\n`);
      return EXIT_CODE.success;
    }
    if (invocation.command === 'mcp') {
      if (json) throw usageError('mcp does not take --json; the protocol is already JSON-RPC');
      const input = host.input;
      if (input === undefined) {
        throw usageError(
          'mcp needs a request stream on stdin',
          'An MCP client starts this command as a subprocess and speaks JSON-RPC over the pipe.',
        );
      }
      // Imported here, not at the top: mcp.ts is built on this module, and the
      // other commands must not pay for a protocol they never speak.
      const { serve } = await import('./mcp.js');
      return await serve(host, input);
    }
    const result = await dispatch(host, invocation);
    host.write(
      json
        ? `${JSON.stringify({ ok: true, command: invocation.command, ...result.json })}\n`
        : renderText(result),
    );
    return EXIT_CODE.success;
  } catch (error) {
    if (error instanceof CliError) {
      host.writeError(renderFailure(error, json));
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : 'Unrecognized failure';
    host.writeError(renderFailure(
      new CliError(
        'unknown_outcome',
        `The command ended in an unhandled failure: ${message}`,
        'Reconcile with miakapp release or miakapp upload before publishing again.',
      ),
      json,
    ));
    return EXIT_CODE.unknown_outcome;
  }
}
