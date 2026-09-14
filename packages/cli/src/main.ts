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
import { prepareArtifact, type Artifact } from './artifact.js';
import { exchangePublisherToken, fetchDiscovery } from './control-plane.js';
import { discoverFlows, inventoryJson, type Inventory } from './discovery.js';
import {
  CliError,
  EXIT_CODE,
  artifactError,
  authorizationError,
  projectError,
  usageError,
} from './errors.js';
import type { FetchLike } from './internal/http.js';
import { isDigest, isRelease, REQUIREMENT_KINDS, type Requirements } from './internal/names.js';
import { PROJECT_FILE, PROJECT_SCHEMA, findProjectFile, parseProject, type Project } from './project.js';
import {
  activateRelease,
  publish,
  readRelease,
  readUpload,
  type ComponentPointer,
  type PublicationTarget,
} from './publication.js';

export const CLI_VERSION = '4.0.0-alpha.0';

/**
 * The Home Key is read from the environment only. A secret passed as an
 * argument would land in shell history, in a process listing and in most CI
 * logs, so no command accepts one.
 */
export const HOME_KEY_VARIABLE = 'MIAKAPP_HOME_KEY';

export interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
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
}

type Field = readonly [key: string, value: string | number | readonly string[]];

interface CommandResult {
  readonly summary: string;
  readonly fields: readonly Field[];
  readonly json: Record<string, unknown>;
}

interface Invocation {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positional: readonly string[];
}

const USAGE = `miakapp ${CLI_VERSION} — build, publish and roll back a Miakapp home component

Usage
  miakapp <command> [options]

Commands
  init                    Write ${PROJECT_FILE} in the current directory
  discover                Inventory an existing Node-RED installation offline
  check                   Validate the project and the artifact offline
  publish                 Upload, finalize and activate the built artifact
  activate                Activate an already finalized digest at a new generation
  rollback                Alias of activate, for returning to a known-good digest
  release <sha256>        Read one finalized release record
  upload <uploadId>       Read one upload status, to reconcile a lost request
  help                    Print this text
  version                 Print the CLI version

Common options
  --json                  Print one machine-readable object on stdout
  --project <dir>         Start the ${PROJECT_FILE} search here (default: cwd)

publish options
  --expected-generation <n>   Generation the pointer is expected to hold (required)
  --generation <n>            Generation to publish (default: expected + 1)
  --release <name>            Override component.release from ${PROJECT_FILE}

activate / rollback options
  --sha256 <digest>           Finalized artifact digest (required)
  --expected-generation <n>   Generation the pointer is expected to hold (required)
  --generation <n>            Generation to publish (default: expected + 1)

discover options
  --flows <path>              Node-RED flows export to read (required)

init options
  --home <homeId>             Home ID to write into ${PROJECT_FILE} (required)
  --control-plane <https url> Control-plane issuer (required)
  --artifact <path>           Built artifact path (default: dist/component.js)
  --release <name>            Initial release name (default: 0.1.0)

Environment
  ${HOME_KEY_VARIABLE}   Home Key with the components:publish scope. Required by
                     publish, activate, rollback, release and upload. It is never
                     accepted as an argument and never printed.

Exit codes
  0 success        1 usage        2 project      3 artifact
  4 authorization  5 contract     6 conflict     7 unknown outcome
`;

const GLOBAL_FLAGS = ['json'] as const;
const GLOBAL_OPTIONS = ['project'] as const;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  init: ['home', 'control-plane', 'artifact', 'release'],
  discover: ['flows'],
  check: [],
  publish: ['expected-generation', 'generation', 'release'],
  activate: ['sha256', 'expected-generation', 'generation'],
  rollback: ['sha256', 'expected-generation', 'generation'],
  release: [],
  upload: [],
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
  return { command, options, flags, positional };
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

/** `--generation` defaults to one above the expected generation, never higher. */
function generationPair(invocation: Invocation): {
  expectedGeneration: number;
  generation: number;
} {
  const expectedGeneration = generationOption(invocation, 'expected-generation');
  const generation = invocation.options.has('generation')
    ? generationOption(invocation, 'generation')
    : expectedGeneration + 1;
  if (generation <= expectedGeneration) {
    throw usageError('--generation must be strictly above --expected-generation');
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

function homeKey(host: CliHost): string {
  const value = host.env(HOME_KEY_VARIABLE);
  if (value === undefined || value === '') {
    throw authorizationError(
      `${HOME_KEY_VARIABLE} is not set`,
      `Export a Home Key holding components:publish as ${HOME_KEY_VARIABLE}. `
      + 'It is never accepted as a command-line argument.',
    );
  }
  return value;
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

async function publicationTarget(host: CliHost, project: Project): Promise<PublicationTarget> {
  const key = homeKey(host);
  const options = host.fetch === undefined ? {} : { fetch: host.fetch };
  const discovery = await fetchDiscovery({ issuer: project.issuer, ...options });
  const token = await exchangePublisherToken(discovery, key, options);
  return { issuer: discovery.issuer, homeId: project.homeId, token: token.accessToken, ...options };
}

function requirementFields(requires: Requirements): readonly Field[] {
  return REQUIREMENT_KINDS.map((kind): Field => [`requires.${kind}`, requires[kind]]);
}

function pointerResult(summary: string, pointer: ComponentPointer): CommandResult {
  return {
    summary,
    fields: [
      ['home', pointer.homeId],
      ['generation', pointer.generation],
      ['release', pointer.release],
      ['sha256', pointer.sha256],
      ['size', pointer.size],
      ['url', pointer.url],
      ...requirementFields(pointer.requires),
    ],
    json: {
      home_id: pointer.homeId,
      generation: pointer.generation,
      release: pointer.release,
      abi: pointer.abi,
      url: pointer.url,
      sha256: pointer.sha256,
      size: pointer.size,
      requires: pointer.requires,
    },
  };
}

function projectTemplate(fields: {
  home: string;
  controlPlane: string;
  artifact: string;
  release: string;
}): string {
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
  const source = projectTemplate({
    home: requiredOption(invocation, 'home'),
    controlPlane: requiredOption(invocation, 'control-plane'),
    artifact: invocation.options.get('artifact') ?? 'dist/component.js',
    release,
  });
  // Parsed before it is written, so init can never emit a file check rejects.
  parseProject(root, source);
  await filesystem.write(path, new TextEncoder().encode(source));
  return {
    summary: `Wrote ${path}`,
    fields: [['project', path]],
    json: { project: path, schema: PROJECT_SCHEMA },
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
  const { expectedGeneration, generation } = generationPair(invocation);
  const project = await loadProject(host, invocation);
  const release = invocation.options.get('release') ?? project.release;
  if (!isRelease(release)) {
    throw usageError('--release must be 1..64 UTF-8 bytes without control characters');
  }
  const artifact = await loadArtifact(host, project);
  const target = await publicationTarget(host, project);
  const { pointer } = await publish(target, artifact, {
    release,
    requires: project.requires,
    expectedGeneration,
    generation,
  });
  return pointerResult(
    `Published ${release} as generation ${pointer.generation}`,
    pointer,
  );
}

async function runActivate(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const sha256 = digestOption(invocation, 'sha256');
  const { expectedGeneration, generation } = generationPair(invocation);
  const project = await loadProject(host, invocation);
  const target = await publicationTarget(host, project);
  // Activation is checked against a readable finalized record first, so a typo
  // in a digest fails as an artifact error instead of spending a CAS attempt.
  const existing = await readRelease(target, sha256);
  if (existing === undefined) {
    throw artifactError(
      `No finalized release for ${sha256}`,
      'Activate only a digest this home has already published.',
    );
  }
  const pointer = await activateRelease(target, { sha256, expectedGeneration, generation });
  return pointerResult(
    `Activated ${existing.release} as generation ${pointer.generation}`,
    pointer,
  );
}

async function runRelease(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  const sha256 = invocation.positional[0];
  if (sha256 === undefined) throw usageError('release requires one sha256 argument');
  if (!isDigest(sha256)) {
    throw usageError('The release digest must be 43 base64url characters');
  }
  const project = await loadProject(host, invocation);
  const target = await publicationTarget(host, project);
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
  const target = await publicationTarget(host, project);
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

async function dispatch(host: CliHost, invocation: Invocation): Promise<CommandResult> {
  switch (invocation.command) {
    case 'init':
      return await runInit(host, invocation);
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
