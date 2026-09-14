/**
 * The same commands, spoken over the Model Context Protocol.
 *
 * An agent that already runs a shell does not need this. An agent that speaks
 * MCP natively does: it gets typed arguments, a description per tool and a
 * closed JSON object per outcome, without a shell, without quoting and without
 * parsing prose. The transport is newline-delimited JSON-RPC 2.0 on stdio.
 *
 * The server is a translation layer and nothing else. It builds the exact argv
 * a person would have typed, hands it to {@link parseArguments} and then to the
 * same dispatch the CLI uses. There is no second implementation of an option,
 * a default or a validation rule to keep in sync — a tool call and a command
 * line either both succeed or both fail the same way.
 *
 * Two deliberate departures from the command line:
 *
 * - a tool that changes the home pointer refuses to run without `confirm:
 *   true`. A model that hallucinated a publication then spends its mistake on
 *   an argument check rather than on a generation;
 * - a failure comes back as a tool result carrying `isError`, not as a
 *   JSON-RPC error. Protocol errors mean the call never happened; a publication
 *   that reached the control plane and failed did happen, and the caller has to
 *   see `kind` to know whether to reconcile.
 *
 * Nothing but framed JSON-RPC is ever written to stdout: a stray log line would
 * desynchronize the stream for the rest of the session.
 */
import { CliError, EXIT_CODE, usageError } from './errors.js';
import {
  CLI_VERSION,
  HOME_KEY_VARIABLE,
  dispatch,
  parseArguments,
  type CliHost,
  type CommandResult,
} from './main.js';

/** Revision of the MCP specification this server implements. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_NAME = 'miakapp';

/**
 * A single JSON-RPC message may not exceed this. The transport is a pipe from
 * a process we do not control, so the reassembly buffer is bounded like every
 * other input in this package.
 */
export const MAXIMUM_MESSAGE_BYTES = 1_048_576;

type ArgumentType = 'string' | 'integer' | 'boolean';

interface ToolArgument {
  /** Tool-facing name. The CLI option is this name with `_` replaced by `-`. */
  readonly name: string;
  readonly type: ArgumentType;
  readonly required: boolean;
  readonly description: string;
}

interface ToolPositional {
  readonly name: string;
  readonly description: string;
}

interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly command: string;
  readonly description: string;
  readonly args: readonly ToolArgument[];
  readonly positional?: ToolPositional;
  /** Reads only; opens no socket and writes no file. */
  readonly readOnly: boolean;
  /** Moves the home pointer, so it demands `confirm: true`. */
  readonly guarded: boolean;
}

const PROJECT_ARGUMENT: ToolArgument = {
  name: 'project',
  type: 'string',
  required: false,
  description: 'Directory to start the miakapp.yaml search from. Defaults to the working directory.',
};

const EXPECTED_GENERATION: ToolArgument = {
  name: 'expected_generation',
  type: 'integer',
  required: true,
  description:
    'Generation the home pointer is expected to hold right now. The activation is a '
    + 'compare-and-set: if the real generation differs the call fails with kind "conflict" and '
    + 'changes nothing. Re-read the state, do not retry blindly.',
};

const GENERATION: ToolArgument = {
  name: 'generation',
  type: 'integer',
  required: false,
  description: 'Generation to publish. Defaults to expected_generation + 1, and must be above it.',
};

const CONFIRM: ToolArgument = {
  name: 'confirm',
  type: 'boolean',
  required: true,
  description:
    'Must be true. Guard against an unintended call: this tool changes what every device in '
    + 'the home runs. Set it only when the owner asked for this exact publication.',
};

/**
 * The exposed surface. Every CLI command is here except `help` and `version`,
 * which an MCP client gets from `initialize` and `tools/list` instead.
 */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'miakapp_discover',
    title: 'Inventory an existing Node-RED house',
    command: 'discover',
    description:
      'Read a Node-RED flows export and report what the house already is: its flows, its MQTT '
      + 'brokers with the topics their nodes actually reach, the v3 MiakAPI surface as V4 state '
      + 'and function candidates, and every node type the inventory does not model. Offline: it '
      + 'reads the file it is given, opens no socket and writes nothing. Needs no project file '
      + 'and no Home Key, because the house it describes has no V4 project yet. Run this before '
      + 'designing anything for a house you inherited.',
    args: [{
      name: 'flows',
      type: 'string',
      required: true,
      description: 'Path to flows.json, or to an Export > All flows download.',
    }],
    readOnly: true,
    guarded: false,
  },
  {
    name: 'miakapp_agent_pack',
    title: 'Install the pack into a repository',
    command: 'agent-pack',
    description:
      'Install the Miakapp agent pack into a repository: the full guide as a file under '
      + '.miakapp/, a pointer to it in AGENTS.md and CLAUDE.md, and this MCP server in .mcp.json. '
      + 'Run it once in a home repository that does not have it, so the next agent opening that '
      + 'repository finds the rules and the tools already wired. It edits rather than replaces: '
      + 'prose outside the miakapp markers is kept, and every other server in .mcp.json is kept '
      + 'by name. Safe to run twice — a file already current is reported unchanged.',
    args: [{
      name: 'dir',
      type: 'string',
      required: false,
      description: 'Repository to install into. Defaults to the working directory.',
    }],
    readOnly: false,
    guarded: false,
  },
  {
    name: 'miakapp_init',
    title: 'Write the project file',
    command: 'init',
    description:
      'Write miakapp.yaml in the project directory. Refuses to overwrite an existing one, so it '
      + 'is safe to call when unsure. Declares no requirements: grant them one at a time, as the '
      + 'component earns them.',
    args: [
      {
        name: 'home',
        type: 'string',
        required: true,
        description: 'Home ID the component is published to.',
      },
      {
        name: 'control_plane',
        type: 'string',
        required: true,
        description: 'Control-plane issuer, an https URL.',
      },
      {
        name: 'artifact',
        type: 'string',
        required: false,
        description: 'Built artifact path. Defaults to dist/component.js.',
      },
      {
        name: 'release',
        type: 'string',
        required: false,
        description: 'Initial release name. Defaults to 0.1.0.',
      },
      PROJECT_ARGUMENT,
    ],
    readOnly: false,
    guarded: false,
  },
  {
    name: 'miakapp_check',
    title: 'Validate the project and the artifact',
    command: 'check',
    description:
      'Parse miakapp.yaml, verify the built artifact against the four ABI 1 rules the broker '
      + 'would reject anyway, and report the digest a publication would bind. Offline and free: '
      + 'run it in CI and before every publication. It never builds the component itself.',
    args: [PROJECT_ARGUMENT],
    readOnly: true,
    guarded: false,
  },
  {
    name: 'miakapp_release',
    title: 'Read one finalized release',
    command: 'release',
    description:
      'Read the finalized release record for one digest: release name, ABI, size, requirements '
      + 'and finalization instant. This is the reconciliation read after a lost finalize '
      + 'response — call it before deciding that a publication did not happen.',
    args: [PROJECT_ARGUMENT],
    positional: {
      name: 'sha256',
      description: 'Artifact digest, 43 base64url characters.',
    },
    readOnly: true,
    guarded: false,
  },
  {
    name: 'miakapp_upload',
    title: 'Read one upload status',
    command: 'upload',
    description:
      'Read the status of one upload: awaiting_upload, delivered or finalized. This is the read '
      + 'that tells a lost PUT from an upload that never arrived. Call it after any '
      + 'unknown_outcome, before touching the control plane again.',
    args: [PROJECT_ARGUMENT],
    positional: {
      name: 'upload_id',
      description: 'Upload ID returned when the capability was issued, 22 characters.',
    },
    readOnly: true,
    guarded: false,
  },
  {
    name: 'miakapp_publish',
    title: 'Publish and activate the built artifact',
    command: 'publish',
    description:
      'Upload the built artifact, finalize it and activate it as the new generation, in one run. '
      + 'Changes what every device in the home runs. Requires MIAKAPP_HOME_KEY in the '
      + 'environment. Run miakapp_check first; this tool does not build the component.',
    args: [
      EXPECTED_GENERATION,
      GENERATION,
      {
        name: 'release',
        type: 'string',
        required: false,
        description: 'Release name for this publication. Defaults to component.release.',
      },
      PROJECT_ARGUMENT,
      CONFIRM,
    ],
    readOnly: false,
    guarded: true,
  },
  {
    name: 'miakapp_activate',
    title: 'Activate an already finalized digest',
    command: 'activate',
    description:
      'Point the home at a digest that was already finalized, at a new generation. Uploads '
      + 'nothing. Use it to promote a release that was published but not activated.',
    args: [
      {
        name: 'sha256',
        type: 'string',
        required: true,
        description: 'Finalized artifact digest, 43 base64url characters.',
      },
      EXPECTED_GENERATION,
      GENERATION,
      PROJECT_ARGUMENT,
      CONFIRM,
    ],
    readOnly: false,
    guarded: true,
  },
  {
    name: 'miakapp_rollback',
    title: 'Return the home to a known-good digest',
    command: 'rollback',
    description:
      'The same operation as miakapp_activate, named for the moment it matters: put the home '
      + 'back on a digest that was working. A rollback is a forward activation of an older '
      + 'artifact, so it takes a new generation too — generations never go backwards.',
    args: [
      {
        name: 'sha256',
        type: 'string',
        required: true,
        description: 'Digest of the release to return to, 43 base64url characters.',
      },
      EXPECTED_GENERATION,
      GENERATION,
      PROJECT_ARGUMENT,
      CONFIRM,
    ],
    readOnly: false,
    guarded: true,
  },
];

/** The CLI option a tool argument stands for. */
export function optionName(argument: string): string {
  return argument.replaceAll('_', '-');
}

function schemaProperty(argument: ToolArgument): Record<string, unknown> {
  if (argument.type === 'integer') {
    return { type: 'integer', minimum: 0, description: argument.description };
  }
  if (argument.type === 'boolean') {
    return { type: 'boolean', description: argument.description };
  }
  return { type: 'string', minLength: 1, description: argument.description };
}

export function inputSchema(tool: ToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (tool.positional !== undefined) {
    properties[tool.positional.name] = {
      type: 'string',
      minLength: 1,
      description: tool.positional.description,
    };
    required.push(tool.positional.name);
  }
  for (const argument of tool.args) {
    properties[argument.name] = schemaProperty(argument);
    if (argument.required) required.push(argument.name);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function descriptor(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema(tool),
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.guarded,
      idempotentHint: false,
      openWorldHint: !tool.readOnly || tool.command === 'release' || tool.command === 'upload',
    },
  };
}

/**
 * Turns tool arguments into the argv a person would have typed.
 *
 * Unknown keys are rejected here rather than dropped: a model that invented an
 * argument has misunderstood the tool, and silently ignoring it would publish
 * something other than what it asked for.
 */
export function buildArgv(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): readonly string[] {
  const byName = new Map(tool.args.map((argument) => [argument.name, argument]));
  const argv: string[] = [tool.command];
  const positional = tool.positional;

  for (const key of Object.keys(args)) {
    if (key === positional?.name) continue;
    if (!byName.has(key)) {
      throw usageError(
        `Unknown argument ${key} for ${tool.name}`,
        `${tool.name} accepts ${[...byName.keys()].join(', ')}.`,
      );
    }
  }

  if (positional !== undefined) {
    const value = args[positional.name];
    if (typeof value !== 'string' || value === '') {
      throw usageError(`${positional.name} is required and must be a non-empty string`);
    }
    argv.push(value);
  }

  for (const argument of tool.args) {
    const value = args[argument.name];
    if (argument.type === 'boolean') {
      // A guard is not an option: it is checked here and never reaches the argv,
      // so the command line keeps exactly the shape it had before MCP existed.
      if (value !== true) {
        throw usageError(
          `${argument.name} must be set to true`,
          'This tool changes what every device in the home runs, and will not act without an '
          + 'explicit confirmation from the caller.',
        );
      }
      continue;
    }
    if (value === undefined) {
      if (argument.required) throw usageError(`${argument.name} is required`);
      continue;
    }
    if (argument.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw usageError(`${argument.name} must be a non-negative integer`);
      }
      argv.push(`--${optionName(argument.name)}`, String(value));
      continue;
    }
    if (typeof value !== 'string' || value === '') {
      throw usageError(`${argument.name} must be a non-empty string`);
    }
    argv.push(`--${optionName(argument.name)}`, value);
  }
  return argv;
}

function failureJson(error: CliError): Record<string, unknown> {
  return {
    ok: false,
    kind: error.kind,
    exit_code: error.exitCode,
    message: error.message,
    ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
  };
}

function toolResult(payload: Record<string, unknown>, isError: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

/**
 * Runs one tool and returns its MCP result.
 *
 * The host handed to the dispatch captures output instead of writing it: the
 * command's own rendering never reaches stdout, which belongs to the protocol.
 */
export async function callTool(
  host: CliHost,
  name: unknown,
  rawArguments: unknown,
): Promise<Record<string, unknown>> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return toolResult(
      failureJson(usageError(
        `Unknown tool: ${typeof name === 'string' ? name : 'a non-string name'}`,
        `This server exposes ${TOOLS.map((item) => item.name).join(', ')}.`,
      )),
      true,
    );
  }
  const args = rawArguments === undefined || rawArguments === null ? {} : rawArguments;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return toolResult(failureJson(usageError('arguments must be a JSON object')), true);
  }

  let result: CommandResult;
  try {
    const argv = buildArgv(tool, args as Record<string, unknown>);
    result = await dispatch(silentHost(host), parseArguments(argv));
  } catch (error) {
    if (error instanceof CliError) return toolResult(failureJson(error), true);
    const message = error instanceof Error ? error.message : 'Unrecognized failure';
    return toolResult(
      failureJson(new CliError(
        'unknown_outcome',
        `The command ended in an unhandled failure: ${message}`,
        'Reconcile with miakapp_release or miakapp_upload before publishing again.',
      )),
      true,
    );
  }
  return toolResult(
    { ok: true, command: tool.command, summary: result.summary, ...result.json },
    false,
  );
}

/** The dispatch never prints; the protocol owns both streams of this process. */
function silentHost(host: CliHost): CliHost {
  return { ...host, write: () => {}, writeError: () => {} };
}

export interface Message {
  /**
   * Declared because every conforming client sends it, and not policed: the
   * method name is what routes a message, so rejecting a mislabelled version
   * would buy an interop failure and no safety property.
   */
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function response(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const INSTRUCTIONS =
  'Publish and roll back one Miakapp home component. Start with miakapp_discover on a house '
  + 'that already exists, then miakapp_check before every publication. A publication is a '
  + 'compare-and-set on the home generation: when a call fails with kind "conflict" the state '
  + 'moved under you, so read it again rather than retrying. When a call fails with kind '
  + '"unknown_outcome" the effect is undetermined — call miakapp_upload or miakapp_release to '
  + 'find out what happened before acting. Every result is a closed JSON object with a stable '
  + `"kind"; branch on that, never on the prose. Publishing needs ${HOME_KEY_VARIABLE} in this `
  + 'server\'s environment; it is never an argument and never printed.';

/**
 * Handles one decoded message.
 *
 * Returns the response to write, or `undefined` for a notification — a
 * JSON-RPC notification carries no id and must never be answered, not even to
 * report that it was not understood.
 */
export async function handleMessage(
  host: CliHost,
  message: Message,
): Promise<Record<string, unknown> | undefined> {
  const { method, id } = message;
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string') {
    return isNotification ? undefined : errorResponse(id, -32600, 'Missing method');
  }
  if (isNotification) return undefined;

  switch (method) {
    case 'initialize':
      return response(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'Miakapp', version: CLI_VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return response(id, {});
    case 'tools/list':
      return response(id, { tools: TOOLS.map(descriptor) });
    case 'tools/call': {
      const params = message.params;
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return errorResponse(id, -32602, 'tools/call requires a params object');
      }
      const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
      return response(id, await callTool(host, name, args));
    }
    default:
      return errorResponse(id, -32601, `Unknown method: ${method}`);
  }
}

/**
 * Splits a byte stream into JSON-RPC messages on newline boundaries.
 *
 * A message longer than {@link MAXIMUM_MESSAGE_BYTES} ends the session instead
 * of growing the buffer: the peer is either broken or hostile, and neither is
 * worth the memory.
 */
export async function* messages(
  input: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') yield line;
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > MAXIMUM_MESSAGE_BYTES) {
      throw new CliError(
        'contract',
        `A single JSON-RPC message exceeded ${MAXIMUM_MESSAGE_BYTES} bytes`,
      );
    }
  }
  const last = buffer.trim();
  if (last !== '') yield last;
}

/**
 * Serves MCP until the input stream ends.
 *
 * Returns an exit code, like every other command. A closed stdin is the normal
 * way an MCP client shuts a server down, so it is success, not failure.
 */
export async function serve(
  host: CliHost,
  input: AsyncIterable<Uint8Array>,
): Promise<number> {
  const write = (payload: Record<string, unknown>): void => {
    host.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    for await (const line of messages(input)) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write(errorResponse(null, -32700, 'Parse error'));
        continue;
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        write(errorResponse(null, -32600, 'A JSON-RPC message must be an object'));
        continue;
      }
      const reply = await handleMessage(host, message as Message);
      if (reply !== undefined) write(reply);
    }
    return EXIT_CODE.success;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unrecognized failure';
    host.writeError(`miakapp: mcp: ${message}\n`);
    return error instanceof CliError ? error.exitCode : EXIT_CODE.unknown_outcome;
  }
}
