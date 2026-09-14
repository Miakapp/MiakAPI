import { describe, expect, test } from 'bun:test';
import { EXIT_CODE } from '../src/errors.js';
import { COMMAND_OPTIONS, HOME_KEY_VARIABLE, run } from '../src/main.js';
import {
  MCP_PROTOCOL_VERSION,
  TOOLS,
  buildArgv,
  callTool,
  handleMessage,
  inputSchema,
  messages,
  optionName,
  serve,
} from '../src/mcp.js';
import { digestOf, fakeControlPlane, homeKey } from './support/control-plane.js';
import { ARTIFACT_SOURCE, MemoryFiles, PROJECT_ROOT, standardProject, testHost } from './support/host.js';
import { FLOWS_PATH, flowsProject } from './support/flows.js';

const HOME_ID = 'test-home';
const ARTIFACT_DIGEST = digestOf(new TextEncoder().encode(ARTIFACT_SOURCE));

function publisherEnvironment(): Record<string, string> {
  return { [HOME_KEY_VARIABLE]: homeKey() };
}

/** Feeds a server one chunk per string, the way a pipe delivers them. */
function stream(...chunks: readonly string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const encoder = new TextEncoder();
      for (const chunk of chunks) yield encoder.encode(chunk);
    },
  };
}

function line(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`;
}

function frames(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No such tool: ${name}`);
  return found;
}

function payload(result: Record<string, unknown>): Record<string, unknown> {
  return result['structuredContent'] as Record<string, unknown>;
}

describe('the tool surface mirrors the command surface', () => {
  test('every command except help, version and mcp itself is a tool', () => {
    const commands = Object.keys(COMMAND_OPTIONS)
      .filter((name) => !['help', 'version', 'mcp'].includes(name))
      .sort();
    expect(TOOLS.map((entry) => entry.command).sort()).toEqual(commands);
  });

  test('no tool hides an option the command accepts', () => {
    for (const entry of TOOLS) {
      const exposed = new Set(entry.args.map((argument) => optionName(argument.name)));
      for (const option of COMMAND_OPTIONS[entry.command] ?? []) {
        expect([entry.name, option, exposed.has(option)]).toEqual([entry.name, option, true]);
      }
    }
  });

  test('no tool invents an option the command would reject', () => {
    for (const entry of TOOLS) {
      const allowed = new Set([...COMMAND_OPTIONS[entry.command] ?? [], 'project']);
      for (const argument of entry.args) {
        if (argument.type === 'boolean') continue; // confirm never reaches the argv
        const option = optionName(argument.name);
        expect([entry.name, option, allowed.has(option)]).toEqual([entry.name, option, true]);
      }
    }
  });

  test('exactly the pointer-moving tools are guarded and declared destructive', () => {
    const guarded = TOOLS.filter((entry) => entry.guarded).map((entry) => entry.command).sort();
    expect(guarded).toEqual(['activate', 'publish', 'rollback']);
    for (const entry of TOOLS) {
      const confirms = entry.args.some((argument) => argument.name === 'confirm');
      expect([entry.name, confirms]).toEqual([entry.name, entry.guarded]);
      expect([entry.name, entry.readOnly && entry.guarded]).toEqual([entry.name, false]);
    }
  });

  test('each schema declares every argument and requires the mandatory ones', () => {
    const listed = TOOLS.map((entry) => entry.name);
    expect(new Set(listed).size).toBe(listed.length);
    for (const entry of TOOLS) {
      const schema = inputSchema(entry);
      const declared = Object.keys(schema['properties'] as Record<string, unknown>).sort();
      const expected = entry.args.map((argument) => argument.name);
      if (entry.positional !== undefined) expected.push(entry.positional.name);
      expect([entry.name, declared]).toEqual([entry.name, expected.sort()]);

      const required = entry.args.filter((argument) => argument.required).map((a) => a.name);
      if (entry.positional !== undefined) required.unshift(entry.positional.name);
      expect([entry.name, schema['required']]).toEqual([entry.name, required]);
    }
  });
});

describe('argument translation', () => {
  test('an integer becomes the decimal option the parser expects', () => {
    expect(buildArgv(tool('miakapp_publish'), { expected_generation: 4, confirm: true }))
      .toEqual(['publish', '--expected-generation', '4']);
  });

  test('an underscore in a tool argument is the CLI hyphen', () => {
    expect(optionName('expected_generation')).toBe('expected-generation');
    expect(buildArgv(tool('miakapp_init'), {
      home: 'lumiere',
      control_plane: 'https://control.example.test/api',
    })).toEqual([
      'init',
      '--home', 'lumiere',
      '--control-plane', 'https://control.example.test/api',
    ]);
  });

  test('a positional argument is passed as a positional, not an option', () => {
    expect(buildArgv(tool('miakapp_release'), { sha256: ARTIFACT_DIGEST }))
      .toEqual(['release', ARTIFACT_DIGEST]);
  });

  test('an invented argument is refused rather than dropped', () => {
    expect(() => buildArgv(tool('miakapp_check'), { force: true })).toThrow(/Unknown argument/);
  });

  test('a missing required argument is refused before anything runs', () => {
    expect(() => buildArgv(tool('miakapp_publish'), { confirm: true })).toThrow(/required/);
  });

  test('a negative generation is refused before the parser sees it', () => {
    expect(() => buildArgv(tool('miakapp_publish'), { expected_generation: -1, confirm: true }))
      .toThrow(/non-negative integer/);
  });

  test('a generation given as a string is refused, not coerced', () => {
    expect(() => buildArgv(tool('miakapp_publish'), { expected_generation: '4', confirm: true }))
      .toThrow(/non-negative integer/);
  });
});

describe('protocol', () => {
  test('initialize announces the protocol revision and the tools capability', async () => {
    const host = testHost();
    const reply = await handleMessage(host, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = reply?.['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe(MCP_PROTOCOL_VERSION);
    expect(result['capabilities']).toEqual({ tools: { listChanged: false } });
    expect((result['serverInfo'] as Record<string, unknown>)['name']).toBe('miakapp');
    expect(result['instructions']).toContain('unknown_outcome');
  });

  test('tools/list describes every tool with a closed schema', async () => {
    const host = testHost();
    const reply = await handleMessage(host, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (reply?.['result'] as { tools: Record<string, unknown>[] }).tools;
    expect(tools).toHaveLength(TOOLS.length);
    for (const descriptor of tools) {
      const schema = descriptor['inputSchema'] as Record<string, unknown>;
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
      expect(descriptor['description']).toBeString();
      expect((descriptor['annotations'] as Record<string, unknown>)['readOnlyHint']).toBeBoolean();
    }
  });

  test('a notification is never answered', async () => {
    const host = testHost();
    expect(await handleMessage(host, { jsonrpc: '2.0', method: 'notifications/initialized' }))
      .toBeUndefined();
  });

  test('an unknown method is a method-not-found error', async () => {
    const host = testHost();
    const reply = await handleMessage(host, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect((reply?.['error'] as Record<string, unknown>)['code']).toBe(-32601);
  });

  test('unparseable input is a parse error that does not end the session', async () => {
    const host = testHost();
    const code = await serve(host, stream('{not json\n', line({ jsonrpc: '2.0', id: 1, method: 'ping' })));
    expect(code).toBe(EXIT_CODE.success);
    const replies = frames(host.stdout());
    expect((replies[0]?.['error'] as Record<string, unknown>)['code']).toBe(-32700);
    expect(replies[1]?.['result']).toEqual({});
  });

  test('a message split across chunks is reassembled', async () => {
    const host = testHost();
    const request = line({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await serve(host, stream(request.slice(0, 10), request.slice(10)));
    expect(frames(host.stdout())[0]?.['id']).toBe(7);
  });

  test('a final message without a trailing newline is still served', async () => {
    const host = testHost();
    await serve(host, stream('{"jsonrpc":"2.0","id":9,"method":"ping"}'));
    expect(frames(host.stdout())[0]?.['id']).toBe(9);
  });

  test('the message reader yields one entry per line and ignores blanks', async () => {
    const seen: string[] = [];
    for await (const entry of messages(stream('a\n\n  \nb\n'))) seen.push(entry);
    expect(seen).toEqual(['a', 'b']);
  });

  test('a closed stream is a clean shutdown, not a failure', async () => {
    const host = testHost();
    expect(await serve(host, stream())).toBe(EXIT_CODE.success);
    expect(host.stdout()).toBe('');
  });
});

describe('read-only tools', () => {
  test('check returns the digest a publication would bind', async () => {
    const host = testHost({ files: standardProject() });
    const result = await callTool(host, 'miakapp_check', { project: PROJECT_ROOT });
    expect(result['isError']).toBe(false);
    expect(payload(result)['sha256']).toBe(ARTIFACT_DIGEST);
    expect(payload(result)['command']).toBe('check');
  });

  test('a result carries the same object in text and in structuredContent', async () => {
    const host = testHost({ files: standardProject() });
    const result = await callTool(host, 'miakapp_check', { project: PROJECT_ROOT });
    const content = (result['content'] as { type: string; text: string }[])[0];
    expect(content?.type).toBe('text');
    expect(JSON.parse(content?.text ?? '')).toEqual(payload(result));
  });

  test('discover inventories a flows export without a project or a key', async () => {
    const host = testHost({ files: flowsProject() });
    const result = await callTool(host, 'miakapp_discover', { flows: FLOWS_PATH });
    expect(result['isError']).toBe(false);
    expect(payload(result)['flows']).toBeArray();
  });

  test('a failing command is a tool result with isError, not a protocol error', async () => {
    const host = testHost({ files: new MemoryFiles({}) });
    const reply = await handleMessage(host, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'miakapp_check', arguments: { project: PROJECT_ROOT } },
    });
    expect(reply?.['error']).toBeUndefined();
    const result = reply?.['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    expect(payload(result)['kind']).toBe('project');
    expect(payload(result)['exit_code']).toBe(EXIT_CODE.project);
  });

  test('an unknown tool fails as a usage result the caller can read', async () => {
    const host = testHost();
    const result = await callTool(host, 'miakapp_deploy_everything', {});
    expect(result['isError']).toBe(true);
    expect(payload(result)['kind']).toBe('usage');
  });
});

describe('guarded tools', () => {
  test('publish without confirm touches nothing', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const result = await callTool(host, 'miakapp_publish', {
      expected_generation: 0,
      project: PROJECT_ROOT,
    });
    expect(result['isError']).toBe(true);
    expect(payload(result)['kind']).toBe('usage');
    expect(payload(result)['message']).toContain('confirm');
    expect(payload(result)['remedy']).toContain('explicit confirmation');
    expect(plane.requests).toEqual([]);
    expect(plane.generation).toBe(0);
  });

  test('publish with confirm false is refused, not treated as absent', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const result = await callTool(host, 'miakapp_publish', {
      expected_generation: 0,
      confirm: false,
      project: PROJECT_ROOT,
    });
    expect(result['isError']).toBe(true);
    expect(payload(result)['message']).toContain('confirm');
    expect(plane.requests).toEqual([]);
  });

  test('publish with confirm walks the whole publication', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const result = await callTool(host, 'miakapp_publish', {
      expected_generation: 0,
      confirm: true,
      project: PROJECT_ROOT,
    });
    expect(result['isError']).toBe(false);
    expect(payload(result)['generation']).toBe(1);
    expect(payload(result)['sha256']).toBe(ARTIFACT_DIGEST);
    expect(plane.generation).toBe(1);
  });

  test('a stale expected generation is a conflict the caller must re-read', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 3 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const result = await callTool(host, 'miakapp_publish', {
      expected_generation: 0,
      confirm: true,
      project: PROJECT_ROOT,
    });
    expect(result['isError']).toBe(true);
    expect(payload(result)['kind']).toBe('conflict');
    expect(plane.generation).toBe(3);
  });

  test('rollback activates a finalized digest at a new generation', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    await callTool(host, 'miakapp_publish', {
      expected_generation: 0,
      confirm: true,
      project: PROJECT_ROOT,
    });
    const result = await callTool(host, 'miakapp_rollback', {
      sha256: ARTIFACT_DIGEST,
      expected_generation: 1,
      confirm: true,
      project: PROJECT_ROOT,
    });
    expect(result['isError']).toBe(false);
    expect(payload(result)['generation']).toBe(2);
  });

  test('a missing Home Key is an authorization failure, and the key never appears', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({ files: standardProject(), fetch: plane.fetch });
    const result = await callTool(host, 'miakapp_publish', {
      expected_generation: 0,
      confirm: true,
      project: PROJECT_ROOT,
    });
    expect(payload(result)['kind']).toBe('authorization');
    expect(JSON.stringify(result)).not.toContain(homeKey());
  });
});

describe('the mcp command', () => {
  test('mcp serves the stream given on the host input', async () => {
    const host = testHost({
      files: standardProject(),
      input: stream(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
    });
    expect(await run(['mcp'], host)).toBe(EXIT_CODE.success);
    const tools = (frames(host.stdout())[0]?.['result'] as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(TOOLS.length);
  });

  test('mcp writes nothing but framed JSON-RPC to stdout', async () => {
    const host = testHost({
      files: standardProject(),
      input: stream(
        line({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        line({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'miakapp_check', arguments: { project: PROJECT_ROOT } },
        }),
      ),
    });
    await run(['mcp'], host);
    const replies = frames(host.stdout());
    expect(replies).toHaveLength(1);
    expect(replies[0]?.['id']).toBe(2);
    expect(host.stderr()).toBe('');
  });

  test('mcp without an input stream is a usage failure, not a hang', async () => {
    const host = testHost({ files: standardProject() });
    expect(await run(['mcp'], host)).toBe(EXIT_CODE.usage);
    expect(host.stderr()).toContain('stdin');
  });

  test('mcp rejects --json rather than corrupting the stream', async () => {
    const host = testHost({ files: standardProject(), input: stream() });
    expect(await run(['mcp', '--json'], host)).toBe(EXIT_CODE.usage);
  });

  test('mcp takes no options of its own', async () => {
    const host = testHost({ input: stream() });
    expect(await run(['mcp', '--flows', 'x'], host)).toBe(EXIT_CODE.usage);
  });
});
