import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import {
  BEGIN_MARKER,
  END_MARKER,
  GUIDE_FILE,
  INSTRUCTION_FILES,
  MCP_FILE,
  SERVER_NAME,
  instructionBlock,
  mergeInstructions,
  mergeMcpConfig,
  serverEntry,
} from '../src/agent-pack.js';
import { EXIT_CODE } from '../src/errors.js';
import { guideAssetPath, run } from '../src/main.js';
import { TOOLS, buildArgv } from '../src/mcp.js';
import { MemoryFiles, PROJECT_ROOT, testHost } from './support/host.js';

const GUIDE_TEXT = '# Building a Miakapp home\n\nThe packaged guide.\n';

/** A repository with the packaged guide in place and whatever else is given. */
async function repository(entries: Record<string, string> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles(entries);
  await files.makeDirectory(PROJECT_ROOT);
  await files.write(await guideAssetPath(), new TextEncoder().encode(GUIDE_TEXT));
  return files;
}

function config(files: MemoryFiles): Record<string, any> {
  return JSON.parse(files.text(`${PROJECT_ROOT}/${MCP_FILE}`));
}

/** A failure prints its one object on stderr, which is where `--json` puts it. */
function failure(host: { stderr(): string }): Record<string, unknown> {
  return JSON.parse(host.stderr()) as Record<string, unknown>;
}

describe('the pack installs into an empty repository', () => {
  test('it writes the guide, both instruction files and the server entry', async () => {
    const files = await repository();
    const host = testHost({ files });

    expect(await run(['agent-pack', '--json'], host)).toBe(EXIT_CODE.success);

    const result = host.json();
    expect(result['root']).toBe(PROJECT_ROOT);
    expect(result['changed']).toBe(4);
    expect((result['files'] as { path: string; action: string }[]).map((entry) => entry.action))
      .toEqual(['created', 'created', 'created', 'created']);

    expect(files.text(`${PROJECT_ROOT}/${GUIDE_FILE}`)).toBe(GUIDE_TEXT);
    for (const { path } of INSTRUCTION_FILES) {
      expect([path, files.text(`${PROJECT_ROOT}/${path}`).includes(GUIDE_FILE)]).toEqual([path, true]);
    }
    expect(config(files)['mcpServers'][SERVER_NAME]).toEqual(serverEntry());
  });

  test('the server is launched by bare name, so the repository is portable', () => {
    const entry = serverEntry();
    expect(entry['command']).toBe(SERVER_NAME);
    expect(entry['args']).toEqual(['mcp']);
    expect(JSON.stringify(entry)).not.toContain('/');
  });

  test('it installs where --dir points, not where the process happens to be', async () => {
    const files = await repository();
    await files.makeDirectory('/srv/another-home');
    const host = testHost({ files });

    expect(await run(['agent-pack', '--dir', '/srv/another-home', '--json'], host))
      .toBe(EXIT_CODE.success);

    expect(await files.exists(`/srv/another-home/${GUIDE_FILE}`)).toBe(true);
    expect(await files.exists(`${PROJECT_ROOT}/${GUIDE_FILE}`)).toBe(false);
  });

  test('a directory that does not exist is a project error, not a silent mkdir', async () => {
    const host = testHost({ files: await repository() });

    expect(await run(['agent-pack', '--dir', '/srv/absent', '--json'], host))
      .toBe(EXIT_CODE.project);
    expect(failure(host)['kind']).toBe('project');
  });

  test('a missing packaged guide fails loudly instead of installing an empty one', async () => {
    const files = new MemoryFiles();
    await files.makeDirectory(PROJECT_ROOT);
    const host = testHost({ files });

    expect(await run(['agent-pack', '--json'], host)).toBe(EXIT_CODE.project);
    expect(failure(host)['message']).toContain('guide');
    expect(await files.exists(`${PROJECT_ROOT}/${GUIDE_FILE}`)).toBe(false);
  });
});

describe('the pack keeps what the owner wrote', () => {
  test('prose already in an instruction file survives, and the block is appended', async () => {
    const existing = '# Our house\n\nRun the tests before you touch the heating.\n';
    const files = await repository({ [`${PROJECT_ROOT}/AGENTS.md`]: existing });
    const host = testHost({ files });

    expect(await run(['agent-pack', '--json'], host)).toBe(EXIT_CODE.success);

    const written = files.text(`${PROJECT_ROOT}/AGENTS.md`);
    expect(written.startsWith(existing)).toBe(true);
    expect(written).toContain(BEGIN_MARKER);
    expect(written).toContain(END_MARKER);
  });

  test('a second run updates the block in place instead of stacking copies', () => {
    const first = mergeInstructions('# Our house\n', instructionBlock('Codex'));
    const stale = first.replace('## Miakapp', '## Miakapp (an older pack wrote this)');
    const second = mergeInstructions(stale, instructionBlock('Codex'));

    expect(second.split(BEGIN_MARKER).length - 1).toBe(1);
    expect(second).not.toContain('an older pack wrote this');
    expect(second.startsWith('# Our house\n')).toBe(true);
    expect(second).toBe(first);
  });

  test('text after the block is carried across untouched', () => {
    const withTail = `${instructionBlock('Codex')}\n\n## After\n\nKept.\n`;
    const merged = mergeInstructions(withTail, instructionBlock('Claude Code'));

    expect(merged).toContain('## After\n\nKept.\n');
    expect(merged).toContain('Claude Code');
  });

  test('an unterminated block is refused rather than guessed at', () => {
    expect(() => mergeInstructions(`# House\n\n${BEGIN_MARKER}\nhalf a block\n`, 'x'))
      .toThrow(/unterminated/i);
  });

  test('other servers and other keys in .mcp.json are kept by name', () => {
    const merged = JSON.parse(mergeMcpConfig(JSON.stringify({
      $schema: 'https://example.test/mcp.json',
      mcpServers: {
        sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
      },
    })));

    expect(merged['$schema']).toBe('https://example.test/mcp.json');
    expect(merged['mcpServers']['sentry']).toEqual({ type: 'http', url: 'https://mcp.sentry.dev/mcp' });
    expect(merged['mcpServers'][SERVER_NAME]).toEqual(serverEntry());
  });

  test('an earlier miakapp entry is replaced, not duplicated', () => {
    const merged = JSON.parse(mergeMcpConfig(JSON.stringify({
      mcpServers: { [SERVER_NAME]: { type: 'stdio', command: '/opt/old/miakapp', args: ['serve'] } },
    })));

    expect(Object.keys(merged['mcpServers'])).toEqual([SERVER_NAME]);
    expect(merged['mcpServers'][SERVER_NAME]).toEqual(serverEntry());
  });

  test('a .mcp.json that does not parse is refused and left on disk', async () => {
    const broken = '{ "mcpServers": { oops\n';
    const files = await repository({ [`${PROJECT_ROOT}/${MCP_FILE}`]: broken });
    const host = testHost({ files });

    expect(await run(['agent-pack', '--json'], host)).toBe(EXIT_CODE.project);
    expect(failure(host)['kind']).toBe('project');
    expect(files.text(`${PROJECT_ROOT}/${MCP_FILE}`)).toBe(broken);
  });

  test('an mcpServers key of the wrong shape is refused', () => {
    expect(() => mergeMcpConfig('{"mcpServers": []}')).toThrow(/not an object/);
    expect(() => mergeMcpConfig('["a list"]')).toThrow(/JSON object/);
  });

  test('an empty file is treated as an empty document, not as a parse failure', () => {
    expect(JSON.parse(mergeMcpConfig(''))['mcpServers'][SERVER_NAME]).toEqual(serverEntry());
    expect(JSON.parse(mergeMcpConfig(undefined))['mcpServers'][SERVER_NAME]).toEqual(serverEntry());
  });
});

describe('running the pack twice is safe', () => {
  test('the second run changes nothing and says so', async () => {
    const files = await repository();

    expect(await run(['agent-pack', '--json'], testHost({ files }))).toBe(EXIT_CODE.success);
    const second = testHost({ files });
    expect(await run(['agent-pack', '--json'], second)).toBe(EXIT_CODE.success);

    const result = second.json();
    expect(result['changed']).toBe(0);
    expect((result['files'] as { action: string }[]).every((entry) => entry.action === 'unchanged'))
      .toBe(true);

    const prose = testHost({ files });
    expect(await run(['agent-pack'], prose)).toBe(EXIT_CODE.success);
    expect(prose.stdout()).toContain('already current');
  });

  test('a guide that moved on is rewritten, and reported as updated', async () => {
    const files = await repository();
    expect(await run(['agent-pack', '--json'], testHost({ files }))).toBe(EXIT_CODE.success);

    await files.replace(await guideAssetPath(), new TextEncoder().encode('# Newer guide\n'));
    const host = testHost({ files });
    expect(await run(['agent-pack', '--json'], host)).toBe(EXIT_CODE.success);

    expect(files.text(`${PROJECT_ROOT}/${GUIDE_FILE}`)).toBe('# Newer guide\n');
    const guide = (host.json()['files'] as { path: string; action: string }[])
      .find((entry) => entry.path.endsWith(GUIDE_FILE));
    expect(guide?.action).toBe('updated');
  });
});

describe('the block tells an agent what it must not get wrong', () => {
  test('it names the guide, the server and the confirmation rule', () => {
    const block = instructionBlock('Codex');
    expect(block).toContain(GUIDE_FILE);
    expect(block).toContain(MCP_FILE);
    expect(block).toContain('confirm: true');
    expect(block).toContain('MIAKAPP_HOME_KEY');
    expect(block).toContain('unknown_outcome');
  });

  test('each instruction file names the client that reads it', () => {
    for (const { path, client } of INSTRUCTION_FILES) {
      expect([path, instructionBlock(client).includes(client)]).toEqual([path, true]);
    }
    expect(INSTRUCTION_FILES.map((entry) => entry.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });
});

describe('the packaged guide is the repository guide', () => {
  test('the asset the command reads is byte-identical to docs/agent-guide.md', async () => {
    const shipped = await readFile(await guideAssetPath());
    const source = await readFile(fileURLToPath(new URL('../../../docs/agent-guide.md', import.meta.url)));

    // If this fails, docs/agent-guide.md changed and packages/cli/assets did
    // not. Copy it across: the pack installs the asset, so a stale asset ships
    // an agent the wrong rules.
    expect(shipped.equals(source)).toBe(true);
  });

  test('the guide is served as a tool and reaches the command as plain argv', () => {
    const tool = TOOLS.find((entry) => entry.name === 'miakapp_agent_pack');
    expect(tool?.command).toBe('agent-pack');
    expect(tool?.guarded).toBe(false);
    expect(tool?.readOnly).toBe(false);
    expect(buildArgv(tool!, { dir: '/srv/home' })).toEqual(['agent-pack', '--dir', '/srv/home']);
    expect(buildArgv(tool!, {})).toEqual(['agent-pack']);
  });
});
