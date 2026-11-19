import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { MCP_FILE, SKILL_ROOTS, mergePackageJson, pinnedVersion } from '../src/agent-pack.js';
import { EXIT_CODE } from '../src/errors.js';
import {
  SKILL_NAMES,
  bridgeAssetPath,
  changelogAssetPath,
  guideAssetPath,
  run,
  skillAssetPath,
} from '../src/main.js';
import { TOOLS, callTool } from '../src/mcp.js';
import {
  CHECK_INTERVAL_MS,
  REGISTRY_LATEST_URL,
  UPDATE_CACHE_FILE,
  changelogUrl,
  changesBetween,
  checkForUpdate,
  compareVersions,
  parseChangelog,
} from '../src/updates.js';
import { CLI_VERSION, PACKAGE_NAME } from '../src/version.js';
import { MemoryFiles, PROJECT_ROOT, testHost } from './support/host.js';

const STORE = '/home/tester/.miakapp';

/** A repository that pins `pinned`, with the packaged assets in place. */
async function repository(entries: Record<string, string> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles(entries);
  await files.makeDirectory(PROJECT_ROOT);
  const assets = [
    await guideAssetPath(),
    await changelogAssetPath(),
    await bridgeAssetPath(),
    fileURLToPath(new URL('../assets/members.md', import.meta.url)),
    ...await Promise.all(SKILL_NAMES.map((name) => skillAssetPath(name))),
  ];
  for (const path of assets) await files.write(path, await readFile(path));
  return files;
}

function mcpPinning(version: string): string {
  return `${JSON.stringify({
    mcpServers: {
      other: { command: 'x' },
      miakapp: { type: 'stdio', command: 'npx', args: ['-y', `${PACKAGE_NAME}@${version}`, 'mcp'] },
    },
  }, null, 2)}\n`;
}

/** A registry and CDN double: answers `latest`, and a changelog per version. */
function network(latest: string | undefined, changelogs: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    requests.push(url);
    if (url === REGISTRY_LATEST_URL) {
      if (latest === undefined) throw new Error('offline');
      return Response.json({ name: PACKAGE_NAME, version: latest });
    }
    for (const [version, body] of Object.entries(changelogs)) {
      if (url === changelogUrl(version)) return Response.json(body);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests };
}

function bump(version: string): string {
  const [major, minor] = version.split('.').map(Number);
  return `${major}.${(minor ?? 0) + 1}.0`;
}

describe('versions', () => {
  test('compare by semver precedence, prereleases first', () => {
    expect(compareVersions('4.7.1', '4.8.0')).toBeLessThan(0);
    expect(compareVersions('4.10.0', '4.9.9')).toBeGreaterThan(0);
    expect(compareVersions('4.0.0-alpha.9', '4.0.0-alpha.10')).toBeLessThan(0);
    expect(compareVersions('4.0.0-alpha.15', '4.0.0')).toBeLessThan(0);
    expect(compareVersions('4.7.1', '4.7.1')).toBe(0);
  });

  test('the pin is read from .mcp.json, and only from the miakapp entry', () => {
    expect(pinnedVersion(mcpPinning('4.7.1'))).toBe('4.7.1');
    expect(pinnedVersion('{"mcpServers":{"miakapp":{"args":["-y","@miakapp/cli@latest"]}}}')).toBeUndefined();
    expect(pinnedVersion('not json')).toBeUndefined();
    expect(pinnedVersion(undefined)).toBeUndefined();
  });
});

describe('the packaged changelog', () => {
  test('parses, is newest first, and describes this very release', async () => {
    const entries = parseChangelog(await readFile(await changelogAssetPath(), 'utf8'), 'changelog');
    expect(entries[0]?.version).toBe(CLI_VERSION);
    const versions = entries.map((entry) => entry.version);
    expect([...versions].sort((a, b) => compareVersions(b, a))).toEqual(versions);
    for (const entry of entries) {
      expect([entry.version, entry.home.length > 0 && entry.steps.length > 0]).toEqual([entry.version, true]);
    }
    for (const version of ['4.4.0', '4.5.0', '4.6.0', '4.7.0']) {
      expect(versions).toContain(version);
    }
  });

  test('a malformed entry is refused rather than skipped', () => {
    expect(() => parseChangelog('{"releases":[{"version":"4.8"}]}', 'x')).toThrow(/malformed/);
  });

  test('changesBetween excludes the start and includes the end', async () => {
    const entries = parseChangelog(await readFile(await changelogAssetPath(), 'utf8'), 'changelog');
    expect(changesBetween(entries, '4.6.1', '4.7.1').map((entry) => entry.version)).toEqual(['4.7.1', '4.7.0']);
  });
});

describe('miakapp changes', () => {
  test('lists what came after the pinned version, with steps for the agent', async () => {
    const files = await repository({ [`${PROJECT_ROOT}/${MCP_FILE}`]: mcpPinning('4.6.1') });
    const host = testHost({ files, fetch: network(CLI_VERSION).fetch });

    expect(await run(['changes', '--json'], host)).toBe(EXIT_CODE.success);
    const result = host.json();
    expect(result['since']).toBe('4.6.1');
    expect(result['up_to_date']).toBe(false);
    const versions = (result['releases'] as { version: string }[]).map((entry) => entry.version);
    expect(versions[0]).toBe(CLI_VERSION);
    expect(versions).toContain('4.7.0');
    expect(versions).not.toContain('4.6.1');
  });

  test('reads the newer release\'s own changelog when the registry has one', async () => {
    const newer = bump(CLI_VERSION);
    const files = await repository({ [`${PROJECT_ROOT}/${MCP_FILE}`]: mcpPinning(CLI_VERSION) });
    const remote = {
      releases: [{ version: newer, date: '2027-01-01', home: 'Something new for the home.', steps: ['Do the new thing.'] }],
    };
    const host = testHost({ files, fetch: network(newer, { [newer]: remote }).fetch });

    expect(await run(['changes'], host)).toBe(EXIT_CODE.success);
    expect(host.stdout()).toContain(`${newer} (2027-01-01)`);
    expect(host.stdout()).toContain('For the home: Something new for the home.');
    expect(host.stdout()).toContain('- Do the new thing.');
    expect(host.stdout()).toContain('npx -y @miakapp/cli@latest update');
  });

  test('offline, it answers from the packaged changelog', async () => {
    const files = await repository();
    const host = testHost({ files, fetch: network(undefined).fetch });
    expect(await run(['changes', '--since', '4.7.0', '--json'], host)).toBe(EXIT_CODE.success);
    const result = host.json();
    expect(result['latest']).toBeNull();
    expect((result['releases'] as { version: string }[]).map((entry) => entry.version)).toContain('4.7.1');
  });

  test('a newer release whose notes cannot be fetched is named, never invented', async () => {
    const newer = bump(CLI_VERSION);
    const files = await repository();
    const host = testHost({ files, fetch: network(newer).fetch });
    expect(await run(['changes', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()['undescribed']).toBe(newer);
  });

  test('a --since that is not a version is a usage error', async () => {
    const host = testHost({ files: await repository(), fetch: network(undefined).fetch });
    expect(await run(['changes', '--since', 'yesterday'], host)).toBe(EXIT_CODE.usage);
  });
});

describe('miakapp update', () => {
  const OLD_BRIDGE_TAIL = '\n// an older bridge body\n';

  async function oldRepository(extra: Record<string, string> = {}): Promise<MemoryFiles> {
    const canonical = await readFile(await bridgeAssetPath(), 'utf8');
    const header = canonical.split('\n').slice(0, 3).join('\n');
    return await repository({
      [`${PROJECT_ROOT}/${MCP_FILE}`]: mcpPinning('4.6.1'),
      [`${PROJECT_ROOT}/package.json`]: `${JSON.stringify({
        name: 'miakapp-home-test',
        scripts: { check: 'x' },
        devDependencies: { [PACKAGE_NAME]: '4.6.1', typescript: '7.0.2' },
        dependencies: { miakapi: '4.6.0' },
      }, null, 2)}\n`,
      [`${PROJECT_ROOT}/app/miakapp.ts`]: `${header}${OLD_BRIDGE_TAIL}`,
      [`${PROJECT_ROOT}/AGENTS.md`]: '# Our house\n\nKeep the heating off in summer.\n',
      ...extra,
    });
  }

  test('pins, rewrites the pack, refreshes the bridge and prints the migrations', async () => {
    const files = await oldRepository();
    const host = testHost({ files });

    expect(await run(['update', '--json'], host)).toBe(EXIT_CODE.success);
    const result = host.json();
    expect(result['previous']).toBe('4.6.1');
    expect(result['version']).toBe(CLI_VERSION);

    expect(pinnedVersion(files.text(`${PROJECT_ROOT}/${MCP_FILE}`))).toBe(CLI_VERSION);
    expect(JSON.parse(files.text(`${PROJECT_ROOT}/${MCP_FILE}`))['mcpServers']['other']).toEqual({ command: 'x' });

    const manifest = JSON.parse(files.text(`${PROJECT_ROOT}/package.json`));
    expect(manifest['devDependencies'][PACKAGE_NAME]).toBe(CLI_VERSION);
    expect(manifest['dependencies']['miakapi']).toBe('4.6.0');
    expect(Object.keys(manifest)).toEqual(['name', 'scripts', 'devDependencies', 'dependencies']);

    expect(files.text(`${PROJECT_ROOT}/app/miakapp.ts`)).toBe(await readFile(await bridgeAssetPath(), 'utf8'));
    expect(files.text(`${PROJECT_ROOT}/AGENTS.md`).startsWith('# Our house\n\nKeep the heating off in summer.\n')).toBe(true);
    for (const { directory } of SKILL_ROOTS) {
      expect(await files.exists(`${PROJECT_ROOT}/${directory}/miakapp-update/SKILL.md`)).toBe(true);
    }

    const migrations = (result['migrations'] as { version: string }[]).map((entry) => entry.version);
    expect(migrations[0]).toBe('4.7.0');
    expect(migrations.at(-1)).toBe(CLI_VERSION);
    expect(result['check']).toEqual({ ran: false });
  });

  test('a bridge someone rewrote is kept and reported', async () => {
    const files = await oldRepository({ [`${PROJECT_ROOT}/app/miakapp.ts`]: '// my own bridge\n' });
    const host = testHost({ files });
    expect(await run(['update'], host)).toBe(EXIT_CODE.success);
    expect(files.text(`${PROJECT_ROOT}/app/miakapp.ts`)).toBe('// my own bridge\n');
    expect(host.stdout()).toContain('kept:');
  });

  test('a repository pinned to a newer release is refused, writing nothing', async () => {
    const newer = bump(CLI_VERSION);
    const files = await repository({ [`${PROJECT_ROOT}/${MCP_FILE}`]: mcpPinning(newer) });
    const host = testHost({ files });
    expect(await run(['update'], host)).toBe(EXIT_CODE.usage);
    expect(pinnedVersion(files.text(`${PROJECT_ROOT}/${MCP_FILE}`))).toBe(newer);
    expect(await files.exists(`${PROJECT_ROOT}/.claude/skills`)).toBe(false);
  });

  test('a project that no longer checks is reported, not fatal', async () => {
    const files = await oldRepository({ [`${PROJECT_ROOT}/miakapp.yaml`]: 'schema: nope\n' });
    const host = testHost({ files });
    expect(await run(['update', '--json'], host)).toBe(EXIT_CODE.success);
    const check = host.json()['check'] as Record<string, unknown>;
    expect(check['ran']).toBe(true);
    expect(check['ok']).toBe(false);
  });

  test('running it twice changes nothing the second time', async () => {
    const files = await oldRepository();
    expect(await run(['update'], testHost({ files }))).toBe(EXIT_CODE.success);
    const second = testHost({ files });
    expect(await run(['update', '--json'], second)).toBe(EXIT_CODE.success);
    expect(second.json()['changed']).toBe(0);
    expect(second.json()['migrations']).toEqual([]);
  });

  test('package.json without the CLI is left alone', () => {
    expect(mergePackageJson('{"dependencies":{"mqtt":"5"}}')).toBeUndefined();
  });
});

describe('the daily update notice', () => {
  const newer = bump(CLI_VERSION);

  async function store(): Promise<MemoryFiles> {
    const files = await repository();
    await files.makeDirectory(STORE);
    return files;
  }

  async function runAt(files: MemoryFiles, fetch: (url: string) => Promise<Response>, now: number, argv: string[]) {
    const h = { ...testHost({ files, fetch, home: '/home/tester', env: { MIAKAPP_UPDATE_CHECK: '1' } }), now: () => now };
    const code = await run(argv, h);
    return { code, h };
  }

  test('a command tells the agent once a day, on stderr, and asks the registry once a day', async () => {
    const files = await store();
    const net = network(newer);
    const start = Date.parse('2026-11-19T08:00:00Z');

    const first = await runAt(files, net.fetch, start, ['version']);
    expect(first.code).toBe(EXIT_CODE.success);

    const one = await runAt(files, net.fetch, start, ['docs', 'members']);
    expect(one.h.stderr()).toContain(`Miakapp ${newer} is available (you have ${CLI_VERSION})`);
    expect(one.h.stdout()).not.toContain('is available');

    const two = await runAt(files, net.fetch, start + 60_000, ['docs', 'members']);
    expect(two.h.stderr()).toBe('');
    expect(net.requests.filter((url) => url === REGISTRY_LATEST_URL).length).toBe(1);

    const tomorrow = await runAt(files, net.fetch, start + CHECK_INTERVAL_MS + 1, ['docs', 'members']);
    expect(tomorrow.h.stderr()).toContain('is available');
    expect(net.requests.filter((url) => url === REGISTRY_LATEST_URL).length).toBe(2);
  });

  test('--json carries a field instead of a sentence', async () => {
    const files = await store();
    const { code, h } = await runAt(files, network(newer).fetch, Date.now(), ['docs', 'members', '--json']);
    expect(code).toBe(EXIT_CODE.success);
    expect(h.stderr()).toBe('');
    expect(h.json()['update_available']).toEqual({
      current: CLI_VERSION,
      latest: newer,
      next_step: 'npx -y @miakapp/cli@latest changes',
    });
  });

  test('offline, nothing is printed and the command succeeds', async () => {
    const files = await store();
    const { code, h } = await runAt(files, network(undefined).fetch, Date.now(), ['docs', 'members']);
    expect(code).toBe(EXIT_CODE.success);
    expect(h.stderr()).toBe('');
    expect(await files.exists(`${STORE}/${UPDATE_CACHE_FILE}`)).toBe(true);
  });

  test('no store directory, no check: nothing is created', async () => {
    const files = await repository();
    const net = network(newer);
    const result = await checkForUpdate({ directory: STORE, files, fetch: net.fetch, now: Date.now(), current: CLI_VERSION });
    expect(result).toBeUndefined();
    expect(net.requests).toEqual([]);
  });

  test('CI and MIAKAPP_UPDATE_CHECK=0 turn it off', async () => {
    for (const env of [{ CI: 'true', MIAKAPP_UPDATE_CHECK: '1' }, { MIAKAPP_UPDATE_CHECK: '0' }]) {
      const files = await store();
      const net = network(newer);
      const h = testHost({ files, fetch: net.fetch, home: '/home/tester', env });
      expect(await run(['docs', 'members', '--json'], h)).toBe(EXIT_CODE.success);
      expect(h.json()['update_available']).toBeUndefined();
      expect(net.requests).toEqual([]);
    }
  });

  test('over MCP, a tool result carries update_available and changes/update are tools', async () => {
    const files = await store();
    const h = testHost({ files, fetch: network(newer).fetch, home: '/home/tester', env: { MIAKAPP_UPDATE_CHECK: '1' } });
    const result = await callTool(h, 'miakapp_docs', { topic: 'members' }) as { structuredContent: Record<string, unknown> };
    expect((result.structuredContent['update_available'] as Record<string, unknown>)['latest']).toBe(newer);
    expect(TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(['miakapp_changes', 'miakapp_update']));
  });
});
