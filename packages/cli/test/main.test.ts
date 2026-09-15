import { describe, expect, test } from 'bun:test';
import { EXIT_CODE } from '../src/errors.js';
import { HOME_KEY_VARIABLE, guideAssetPath, parseArguments, run } from '../src/main.js';
import { CLI_VERSION } from '../src/version.js';
import { digestOf, fakeControlPlane, homeKey } from './support/control-plane.js';
import {
  ARTIFACT_SOURCE,
  MemoryFiles,
  PROJECT_ROOT,
  standardProject,
  testHost,
} from './support/host.js';

const HOME_ID = 'test-home';
const ARTIFACT_DIGEST = digestOf(new TextEncoder().encode(ARTIFACT_SOURCE));

function publisherEnvironment(): Record<string, string> {
  return { [HOME_KEY_VARIABLE]: homeKey() };
}

describe('argument parsing', () => {
  test('no argument prints usage rather than acting', () => {
    expect(parseArguments([]).command).toBe('help');
  });

  test('an option may use either separator', () => {
    const spaced = parseArguments(['publish', '--expected-generation', '4']);
    const joined = parseArguments(['publish', '--expected-generation=4']);
    expect(spaced.options.get('expected-generation')).toBe('4');
    expect(joined.options.get('expected-generation')).toBe('4');
  });

  test('an option outside the command set is a usage failure', () => {
    expect(() => parseArguments(['check', '--sha256', 'x'])).toThrow(/Unknown option/);
  });

  test('a repeated option is a usage failure', () => {
    expect(() => parseArguments(['publish', '--generation', '1', '--generation', '2']))
      .toThrow(/given twice/);
  });

  test('an option without a value is a usage failure', () => {
    expect(() => parseArguments(['publish', '--generation'])).toThrow(/requires a value/);
  });
});

describe('offline commands', () => {
  test('version prints the package version', async () => {
    const host = testHost();
    expect(await run(['version'], host)).toBe(EXIT_CODE.success);
    expect(host.stdout().trim()).toBe(CLI_VERSION);
  });

  test('docs start prints the complete bundled guide without a project or network', async () => {
    const files = new MemoryFiles({
      [await guideAssetPath()]: '# Miakapp agent guide\n\nStart here.\n',
    });
    const host = testHost({ files, fetch: async () => { throw new Error('network used'); } });

    expect(await run(['docs', 'start'], host)).toBe(EXIT_CODE.success);
    expect(host.stdout()).toBe('# Miakapp agent guide\n\nStart here.\n');
    expect(host.stderr()).toBe('');
  });

  test('docs rejects an unknown topic instead of printing the wrong contract', async () => {
    const host = testHost();

    expect(await run(['docs', 'publish'], host)).toBe(EXIT_CODE.usage);
    expect(host.stderr()).toContain('miakapp docs start');
  });

  test('an unknown command exits with the usage code', async () => {
    const host = testHost();
    expect(await run(['deploy-everything'], host)).toBe(EXIT_CODE.usage);
    expect(host.stderr()).toContain('usage:');
  });

  test('check reports the digest the publication would bind', async () => {
    const host = testHost({ files: standardProject() });
    expect(await run(['check'], host)).toBe(EXIT_CODE.success);
    expect(host.stdout()).toContain(ARTIFACT_DIGEST);
    expect(host.stdout()).toContain('requires.call: [lighting.set]');
  });

  test('check --json emits one closed object', async () => {
    const host = testHost({ files: standardProject() });
    expect(await run(['check', '--json'], host)).toBe(EXIT_CODE.success);
    const report = host.json();
    expect(report['ok']).toBe(true);
    expect(report['home_id']).toBe(HOME_ID);
    expect(report['sha256']).toBe(ARTIFACT_DIGEST);
    expect(report['requires']).toEqual({
      state_read: ['climate.living_room.temperature'],
      event_subscribe: [],
      event_publish: [],
      call: ['lighting.set'],
      presentation: [],
    });
  });

  test('check runs from a subdirectory of the project', async () => {
    const host = testHost({ files: standardProject(), cwd: `${PROJECT_ROOT}/ui/src` });
    expect(await run(['check'], host)).toBe(EXIT_CODE.success);
  });

  test('a missing project file is a project failure', async () => {
    const host = testHost({ files: new MemoryFiles() });
    expect(await run(['check'], host)).toBe(EXIT_CODE.project);
    expect(host.stderr()).toContain('miakapp.yaml');
  });

  test('a missing artifact is an artifact failure', async () => {
    const files = standardProject();
    files.entries.delete(`${PROJECT_ROOT}/dist/component.js`);
    const host = testHost({ files });
    expect(await run(['check'], host)).toBe(EXIT_CODE.artifact);
  });

  test('module syntax in the artifact is rejected before any upload', async () => {
    const host = testHost({ files: standardProject("import { x } from './x.js';\n") });
    expect(await run(['check'], host)).toBe(EXIT_CODE.artifact);
    expect(host.stderr()).toContain('module_syntax');
  });

  test('a dynamic import in the artifact is rejected', async () => {
    const host = testHost({ files: standardProject("const load = () => import('./x.js');\n") });
    expect(await run(['check'], host)).toBe(EXIT_CODE.artifact);
    expect(host.stderr()).toContain('dynamic_import');
  });

  test('init writes a project file that check accepts', async () => {
    const files = new MemoryFiles();
    const host = testHost({ files });
    const code = await run([
      'init',
      '--home', HOME_ID,
      '--control-plane', 'https://control.example.test/api',
    ], host);
    expect(code).toBe(EXIT_CODE.success);

    files.entries.set(
      `${PROJECT_ROOT}/dist/component.js`,
      new TextEncoder().encode(ARTIFACT_SOURCE),
    );
    const second = testHost({ files });
    expect(await run(['check'], second)).toBe(EXIT_CODE.success);
  });

  test('init never overwrites an existing project file', async () => {
    const host = testHost({ files: standardProject() });
    const code = await run([
      'init',
      '--home', HOME_ID,
      '--control-plane', 'https://control.example.test/api',
    ], host);
    expect(code).toBe(EXIT_CODE.project);
    expect(host.stderr()).toContain('already exists');
  });
});

describe('publication', () => {
  test('publish walks capability, delivery, finalization and activation', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const code = await run(['publish', '--expected-generation', '0', '--json'], host);
    expect(code).toBe(EXIT_CODE.success);

    const pointer = host.json();
    expect(pointer['ok']).toBe(true);
    expect(pointer['generation']).toBe(1);
    expect(pointer['sha256']).toBe(ARTIFACT_DIGEST);
    expect(pointer['release']).toBe('2026-09-13.1');
    expect(pointer['url']).toBe(
      `https://control.example.test/api/v1/components/${ARTIFACT_DIGEST}.js`,
    );
    expect(plane.generation).toBe(1);

    const methods = plane.requests.map((request) => request.split(' ')[0]);
    expect(methods).toEqual(['GET', 'POST', 'POST', 'PUT', 'GET', 'POST', 'POST']);
  });

  test('publish without a Home Key is an authorization failure', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID });
    const host = testHost({ files: standardProject(), fetch: plane.fetch });
    expect(await run(['publish', '--expected-generation', '0'], host))
      .toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain(HOME_KEY_VARIABLE);
    expect(plane.requests).toEqual([]);
  });

  test('the Home Key never appears in output', async () => {
    const key = homeKey();
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: { [HOME_KEY_VARIABLE]: key },
    });
    await run(['publish', '--expected-generation', '0'], host);
    expect(host.stdout()).not.toContain(key);
    expect(host.stderr()).not.toContain(key);
  });

  test('a stale expected generation exits with the conflict code', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 7 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    expect(await run(['publish', '--expected-generation', '0'], host)).toBe(EXIT_CODE.conflict);
    expect(host.stderr()).toContain('generation_conflict');
    expect(plane.generation).toBe(7);
  });

  test('--generation must be strictly above --expected-generation', async () => {
    const host = testHost({ files: standardProject(), env: publisherEnvironment() });
    const code = await run(
      ['publish', '--expected-generation', '4', '--generation', '4'],
      host,
    );
    expect(code).toBe(EXIT_CODE.usage);
  });

  test('a lost upload response is reconciled instead of re-delivered', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    await run(['publish', '--expected-generation', '0'], host);
    const uploadId = [...plane.uploads.keys()][0] as string;

    const reader = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    expect(await run(['upload', uploadId, '--json'], reader)).toBe(EXIT_CODE.success);
    expect(reader.json()['status']).toBe('finalized');
  });
});

describe('activation and rollback', () => {
  async function publishOnce(plane: ReturnType<typeof fakeControlPlane>): Promise<void> {
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    expect(await run(['publish', '--expected-generation', '0'], host)).toBe(EXIT_CODE.success);
  }

  test('rollback republishes a known digest at a greater generation', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    await publishOnce(plane);

    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const code = await run([
      'rollback',
      '--sha256', ARTIFACT_DIGEST,
      '--expected-generation', '1',
      '--json',
    ], host);
    expect(code).toBe(EXIT_CODE.success);
    expect(host.json()['generation']).toBe(2);
    expect(plane.generation).toBe(2);
  });

  test('activating an unpublished digest fails before the pointer is touched', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 3 });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const code = await run([
      'activate',
      '--sha256', digestOf(new TextEncoder().encode('never published')),
      '--expected-generation', '3',
    ], host);
    expect(code).toBe(EXIT_CODE.artifact);
    expect(plane.generation).toBe(3);
    expect(plane.requests.some((request) => request.includes(':activate'))).toBe(false);
  });

  test('a malformed digest is caught as usage before any request', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID });
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    const code = await run([
      'activate',
      '--sha256', 'not-a-digest',
      '--expected-generation', '0',
    ], host);
    expect(code).toBe(EXIT_CODE.usage);
    expect(plane.requests).toEqual([]);
  });

  test('release reads back the finalized record', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    await publishOnce(plane);
    const host = testHost({
      files: standardProject(),
      fetch: plane.fetch,
      env: publisherEnvironment(),
    });
    expect(await run(['release', ARTIFACT_DIGEST, '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()['release']).toBe('2026-09-13.1');
  });
});
