import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  CREDENTIALS_FILE,
  mutateContexts,
  readContexts,
  readCredential,
} from '../src/contexts.js';
import { EXIT_CODE } from '../src/errors.js';
import { CONTEXT_VARIABLE, HOME_KEY_VARIABLE, run } from '../src/main.js';
import { callTool } from '../src/mcp.js';
import { ISSUER, fakeControlPlane, homeKey, type FakeControlPlane } from './support/control-plane.js';
import { MemoryFiles, PROJECT_ROOT, standardProject, testHost } from './support/host.js';

const HOME_ID = 'test-home';
const OTHER_HOME = 'other-home';
const CODE = 'K7QX-93FP-LM2D';

let home: string;
let store: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'miakapp-contexts-'));
  store = join(home, '.miakapp');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function plane(homeId = HOME_ID, options: Partial<Parameters<typeof fakeControlPlane>[0]> = {}): FakeControlPlane {
  const created = fakeControlPlane({ homeId, ...options });
  created.pairingCodes.set(CODE, homeId);
  return created;
}

function secret(value: string): { readSecret: (prompt: string) => Promise<string>; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    readSecret: async (prompt) => {
      prompts.push(prompt);
      return value;
    },
  };
}

async function pair(
  control: FakeControlPlane,
  extra: readonly string[] = [],
  code = `${CODE}\n`,
): Promise<{ code: number; host: ReturnType<typeof testHost> }> {
  const host = testHost({ fetch: control.fetch, home, ...secret(code) });
  const exit = await run(['pair', '--issuer', ISSUER, '--json', ...extra], host);
  return { code: exit, host };
}

function everythingPrinted(host: ReturnType<typeof testHost>): string {
  return host.stdout() + host.stderr();
}

async function storedKey(name: string): Promise<string> {
  return (await readCredential(store, name)).homeKey;
}

describe('miakapp pair', () => {
  test('redeems the code once and stores a private context without printing secrets', async () => {
    const control = plane();
    const { code, host } = await pair(control);

    expect(code).toBe(EXIT_CODE.success);
    expect(control.pairingRequests).toEqual([{ code: CODE, label: 'miakapp-cli@test-machine' }]);
    expect(control.pairingCodes.size).toBe(0);

    const report = host.json();
    expect(report).toMatchObject({
      ok: true,
      command: 'pair',
      context: HOME_ID,
      home_id: HOME_ID,
      issuer: ISSUER,
      current: true,
      publish_access: 'verified',
      earlier_contexts_for_this_home: [],
    });
    const key = await storedKey(HOME_ID);
    expect(report['key_id']).toBe(key.slice(5, 27));
    expect(everythingPrinted(host)).not.toContain(key);
    expect(everythingPrinted(host)).not.toContain(CODE);
    // The fresh key was proven usable for publication before pair returned.
    expect(control.exchangedKeys).toEqual([key]);

    if (process.platform !== 'win32') {
      expect((await lstat(store)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(store, CREDENTIALS_FILE))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(store, CONFIG_FILE))).mode & 0o777).toBe(0o600);
    }
    // The configuration is the half that is safe to show: it holds no key.
    expect(await readFile(join(store, CONFIG_FILE), 'utf8')).not.toContain('mhk1_');
    expect((await readdir(store)).sort()).toEqual([CONFIG_FILE, CREDENTIALS_FILE]);
  });

  test('a second home is added beside the first, which keeps its key', async () => {
    const first = plane(HOME_ID);
    expect((await pair(first)).code).toBe(EXIT_CODE.success);
    const firstKey = await storedKey(HOME_ID);

    const second = plane(OTHER_HOME);
    expect((await pair(second)).code).toBe(EXIT_CODE.success);

    const state = await readContexts(store);
    expect([...state.contexts.keys()].sort()).toEqual([OTHER_HOME, HOME_ID]);
    expect(state.current).toBe(OTHER_HOME);
    expect(await storedKey(HOME_ID)).toBe(firstKey);
    expect(await storedKey(OTHER_HOME)).not.toBe(firstKey);
  });

  test('pairing the same home again keeps the earlier context and reports it', async () => {
    const control = plane();
    expect((await pair(control)).code).toBe(EXIT_CODE.success);
    control.pairingCodes.set('SECOND-CODE', HOME_ID);
    const { code, host } = await pair(control, [], 'SECOND-CODE');

    expect(code).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({
      context: `${HOME_ID}-2`,
      earlier_contexts_for_this_home: [HOME_ID],
    });
    expect((await readContexts(store)).contexts.size).toBe(2);
  });

  test('an existing --name is refused before the code is read or sent', async () => {
    const control = plane();
    expect((await pair(control, ['--name', 'cabin'])).code).toBe(EXIT_CODE.success);
    control.pairingCodes.set('ANOTHER-CODE', HOME_ID);

    const reader = secret('ANOTHER-CODE');
    const host = testHost({ fetch: control.fetch, home, readSecret: reader.readSecret });
    const before = control.requests.length;
    expect(await run(['pair', '--issuer', ISSUER, '--name', 'cabin'], host)).toBe(EXIT_CODE.usage);
    expect(reader.prompts).toEqual([]);
    expect(control.requests.length).toBe(before);
    expect(control.pairingCodes.has('ANOTHER-CODE')).toBe(true);
  });

  test('the code is read through the hidden prompt, never required as an argument', async () => {
    const control = plane();
    const reader = secret(`  ${CODE}  \n`);
    const host = testHost({ fetch: control.fetch, home, readSecret: reader.readSecret });
    expect(await run(['pair', '--issuer', ISSUER], host)).toBe(EXIT_CODE.success);
    expect(reader.prompts).toEqual(['Pairing code (hidden): ']);
    expect(host.stdout()).toContain(`Paired ${HOME_ID} as context ${HOME_ID}`);
    expect(everythingPrinted(host)).not.toContain(CODE);
  });

  test('an explicit --code works and is not echoed', async () => {
    const control = plane();
    const host = testHost({ fetch: control.fetch, home });
    expect(await run(['pair', '--issuer', ISSUER, '--code', CODE], host)).toBe(EXIT_CODE.success);
    expect(everythingPrinted(host)).not.toContain(CODE);
  });

  test('without a code source the command explains how to pipe one', async () => {
    const host = testHost({ fetch: plane().fetch, home });
    expect(await run(['pair', '--issuer', ISSUER], host)).toBe(EXIT_CODE.usage);
    expect(host.stderr()).toContain('printf %s "$CODE" | miakapp pair');
  });

  test('a non-https issuer is refused before any network use', async () => {
    const control = plane();
    const host = testHost({ fetch: control.fetch, home, ...secret(CODE) });
    expect(await run(['pair', '--issuer', 'http://control.example.test'], host)).toBe(EXIT_CODE.usage);
    expect(await run(['pair', '--issuer', `${ISSUER}/`], host)).toBe(EXIT_CODE.usage);
    expect(control.requests).toEqual([]);
  });

  test('an issuer whose discovery names another issuer never receives the code', async () => {
    const control = plane();
    const host = testHost({
      fetch: async (input, init) => {
        if (input.endsWith('/.well-known/miakapp-control-plane')) {
          return new Response(JSON.stringify({
            schema: 'miakapp.control-plane-discovery/1',
            issuer: 'https://attacker.example.test',
            jwks_uri: 'https://attacker.example.test/jwks',
            exchange_endpoint: 'https://attacker.example.test/x',
            user_relay_exchange_endpoint: 'https://attacker.example.test/y',
            push_audience: 'https://attacker.example.test/p',
            components_audience: 'https://attacker.example.test/c',
          }), { status: 200 });
        }
        return control.fetch(input, init);
      },
      home,
      ...secret(CODE),
    });
    expect(await run(['pair', '--issuer', ISSUER], host)).toBe(EXIT_CODE.contract);
    expect(control.pairingRequests).toEqual([]);
    expect(control.pairingCodes.has(CODE)).toBe(true);
  });

  test('a used, expired or wrong code is an authorization failure pointing to the pairing page', async () => {
    const control = plane();
    control.pairingCodes.clear();
    const { code, host } = await pair(control);
    expect(code).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain('https://miakapp.com/pair');
    expect(host.stderr()).toContain('invalid_pairing_code');
    expect((await readContexts(store)).contexts.size).toBe(0);
  });

  test('throttling is reported with its delay and never retried', async () => {
    const control = plane(HOME_ID, {
      fail: new Map([['POST /v1/pairing/redeem', { status: 429, code: 'rate_limited' }]]),
    });
    const { code, host } = await pair(control);
    expect(code).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain('too many attempts');
    expect(control.requests.filter((entry) => entry === 'POST /v1/pairing/redeem')).toHaveLength(1);
  });

  test('a lost response is an unknown outcome, because a key may have been issued', async () => {
    const control = plane();
    const host = testHost({
      fetch: async (input, init) => {
        if (input.endsWith('/v1/pairing/redeem')) throw new TypeError('socket hang up');
        return control.fetch(input, init);
      },
      home,
      ...secret(CODE),
    });
    expect(await run(['pair', '--issuer', ISSUER, '--json'], host)).toBe(EXIT_CODE.unknown_outcome);
    expect(host.stderr()).toContain('revoke any Home Key labelled');
  });

  test('a response without no-store is refused and nothing is stored', async () => {
    const control = plane(HOME_ID, {
      pairingResponse: (issued) => new Response(JSON.stringify({
        home_key: issued.homeKey,
        home_id: issued.homeId,
        key_id: issued.keyId,
        issuer: ISSUER,
      }), { status: 200 }),
    });
    const { code, host } = await pair(control);
    expect(code).toBe(EXIT_CODE.contract);
    expect(host.stderr()).toContain('no-store');
    expect((await readContexts(store)).contexts.size).toBe(0);
  });

  for (const [label, mutate] of [
    ['another issuer', (body: Record<string, unknown>) => ({ ...body, issuer: 'https://evil.example.test' })],
    ['a key ID the key does not carry', (body: Record<string, unknown>) => ({ ...body, key_id: 'A'.repeat(22) })],
    ['an invalid home ID', (body: Record<string, unknown>) => ({ ...body, home_id: 'Not A Home' })],
    ['an unknown member', (body: Record<string, unknown>) => ({ ...body, scopes: ['everything'] })],
    ['a malformed key', (body: Record<string, unknown>) => ({ ...body, home_key: 'plaintext' })],
  ] as const) {
    test(`a response naming ${label} is refused and nothing is stored`, async () => {
      const control = plane(HOME_ID, {
        pairingResponse: (issued) => new Response(JSON.stringify(mutate({
          home_key: issued.homeKey,
          home_id: issued.homeId,
          key_id: issued.keyId,
          issuer: ISSUER,
        })), { status: 200, headers: { 'cache-control': 'no-store' } }),
      });
      const { code, host } = await pair(control);
      expect(code).toBe(EXIT_CODE.contract);
      expect(host.stderr()).not.toContain('mhk1_');
      expect((await readContexts(store)).contexts.size).toBe(0);
    });
  }

  test('a key that cannot obtain a publication token is stored and reported as refused', async () => {
    const control = plane(HOME_ID, {
      fail: new Map([['POST /v1/access-tokens:exchange', { status: 403, code: 'insufficient_scope' }]]),
    });
    const { code, host } = await pair(control);
    expect(code).toBe(EXIT_CODE.success);
    expect(host.json()['publish_access']).toBe('refused');
    expect((await readContexts(store)).contexts.has(HOME_ID)).toBe(true);
  });

  test('MCP pairs from a tool argument, never from the protocol stdin', async () => {
    const control = plane();
    let stdinRead = false;
    const host = testHost({
      fetch: control.fetch,
      home,
      readSecret: async () => {
        stdinRead = true;
        return 'WRONG';
      },
    });
    const result = await callTool(host, 'miakapp_pair', { code: CODE, issuer: ISSUER });
    expect(result['isError']).toBe(false);
    expect(stdinRead).toBe(false);
    expect(JSON.stringify(result)).not.toContain('mhk1_');
    expect(JSON.stringify(result)).not.toContain(CODE);

    const missing = await callTool(host, 'miakapp_pair', { issuer: ISSUER });
    expect(missing['isError']).toBe(true);
  });
});

describe('credential selection', () => {
  async function pairedHome(homeId: string): Promise<FakeControlPlane> {
    const control = plane(homeId);
    expect((await pair(control)).code).toBe(EXIT_CODE.success);
    return control;
  }

  test('publish uses the paired context without any environment export', async () => {
    const control = await pairedHome(HOME_ID);
    const key = await storedKey(HOME_ID);
    const host = testHost({ files: standardProject(), fetch: control.fetch, home });

    expect(await run(['publish', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({
      generation: 1,
      expected_generation: 0,
      credential_source: 'context',
      context: HOME_ID,
    });
    expect(control.exchangedKeys.at(-1)).toBe(key);
    expect(control.requests).toContain(`GET /v1/homes/${HOME_ID}/component-pointer`);
    expect(everythingPrinted(host)).not.toContain(key);
  });

  test('the context matching the project wins over a current context for another home', async () => {
    const control = await pairedHome(HOME_ID);
    await pairedHome(OTHER_HOME);
    expect((await readContexts(store)).current).toBe(OTHER_HOME);

    const host = testHost({ files: standardProject(), fetch: control.fetch, home });
    expect(await run(['status', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({ context: HOME_ID, generation: 0, active: false });
  });

  test('an explicit context for another home is refused before anything is sent', async () => {
    const control = await pairedHome(OTHER_HOME);
    const before = control.requests.length;
    const host = testHost({ files: standardProject(), fetch: control.fetch, home });

    expect(await run(['publish', '--context', OTHER_HOME], host)).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain(`is for home ${OTHER_HOME}`);
    expect(host.stderr()).toContain(`targets home ${HOME_ID}`);
    expect(control.requests.length).toBe(before);
  });

  test('MIAKAPP_CONTEXT selects like --context, and the flag wins over it', async () => {
    const control = await pairedHome(HOME_ID);
    await pairedHome(OTHER_HOME);

    const wrong = testHost({
      files: standardProject(),
      fetch: control.fetch,
      home,
      env: { [CONTEXT_VARIABLE]: OTHER_HOME },
    });
    expect(await run(['status'], wrong)).toBe(EXIT_CODE.authorization);

    const flagged = testHost({
      files: standardProject(),
      fetch: control.fetch,
      home,
      env: { [CONTEXT_VARIABLE]: OTHER_HOME },
    });
    expect(await run(['status', '--context', HOME_ID], flagged)).toBe(EXIT_CODE.success);
  });

  test('an explicit context wins over MIAKAPP_HOME_KEY', async () => {
    const control = await pairedHome(HOME_ID);
    const key = await storedKey(HOME_ID);
    const host = testHost({
      files: standardProject(),
      fetch: control.fetch,
      home,
      env: { [HOME_KEY_VARIABLE]: homeKey() },
    });
    expect(await run(['status', '--context', HOME_ID, '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()['credential_source']).toBe('context');
    expect(control.exchangedKeys.at(-1)).toBe(key);
  });

  test('MIAKAPP_HOME_KEY still works alone, for CI, and wins over stored contexts', async () => {
    const control = await pairedHome(HOME_ID);
    const ciKey = homeKey();
    const host = testHost({
      files: standardProject(),
      fetch: control.fetch,
      home,
      env: { [HOME_KEY_VARIABLE]: ciKey },
    });
    expect(await run(['status', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({ credential_source: 'environment', context: null });
    expect(control.exchangedKeys.at(-1)).toBe(ciKey);
  });

  test('MIAKAPP_HOME_KEY known to belong to another stored home is refused', async () => {
    const control = await pairedHome(OTHER_HOME);
    const otherKey = await storedKey(OTHER_HOME);
    const before = control.requests.length;
    const host = testHost({
      files: standardProject(),
      fetch: control.fetch,
      home,
      env: { [HOME_KEY_VARIABLE]: otherKey },
    });
    expect(await run(['publish'], host)).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain(`paired as context ${OTHER_HOME}`);
    expect(control.requests.length).toBe(before);
  });

  test('no credential at all names the pairing flow as the remedy', async () => {
    const host = testHost({ files: standardProject(), fetch: plane().fetch, home });
    expect(await run(['publish'], host)).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain(`No credential for home ${HOME_ID}`);
    expect(host.stderr()).toContain('miakapp pair');
  });

  test('status after publish shows what is live and the digest to roll back to', async () => {
    const control = await pairedHome(HOME_ID);
    const publisher = testHost({ files: standardProject(), fetch: control.fetch, home });
    expect(await run(['publish', '--json'], publisher)).toBe(EXIT_CODE.success);
    const published = publisher.json();

    const reader = testHost({ files: standardProject(), fetch: control.fetch, home });
    expect(await run(['status', '--json'], reader)).toBe(EXIT_CODE.success);
    expect(reader.json()).toMatchObject({
      active: true,
      generation: 1,
      sha256: published['sha256'],
      release: published['release'],
    });
    expect(reader.json()['expected_generation']).toBeUndefined();
  });

  test('a publication read live still fails as a conflict when the pointer moves', async () => {
    const control = await pairedHome(HOME_ID);
    const original = control.fetch;
    const racing: typeof original = async (input, init) => {
      const response = await original(input, init);
      // Another publisher activates between the pointer read and this one's activation.
      if (input.endsWith('/component-pointer')) control.generation += 1;
      return response;
    };
    const host = testHost({ files: standardProject(), fetch: racing, home });
    expect(await run(['publish'], host)).toBe(EXIT_CODE.conflict);
  });

  test('init after pair needs no identifier typed by hand', async () => {
    await pairedHome(HOME_ID);
    const files = new MemoryFiles();
    const host = testHost({ files, home });
    expect(await run(['init', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({ home_id: HOME_ID, control_plane: ISSUER, context: HOME_ID });
    expect(files.text(`${PROJECT_ROOT}/miakapp.yaml`)).toContain(`home: ${HOME_ID}\ncontrol_plane: ${ISSUER}\n`);
  });

  test('init refuses a --home that contradicts the context it was told to use', async () => {
    await pairedHome(HOME_ID);
    const host = testHost({ files: new MemoryFiles(), home });
    expect(await run(['init', '--context', HOME_ID, '--home', OTHER_HOME], host)).toBe(EXIT_CODE.usage);
  });
});

describe('miakapp context', () => {
  async function seed(): Promise<void> {
    expect((await pair(plane(HOME_ID))).code).toBe(EXIT_CODE.success);
    expect((await pair(plane(OTHER_HOME))).code).toBe(EXIT_CODE.success);
  }

  test('list shows every home and never a key', async () => {
    await seed();
    const host = testHost({ home });
    expect(await run(['context', 'list', '--json'], host)).toBe(EXIT_CODE.success);
    const report = host.json();
    expect(report['current_context']).toBe(OTHER_HOME);
    const contexts = report['contexts'] as Array<Record<string, unknown>>;
    expect(contexts.map((entry) => [entry['name'], entry['current'], entry['credential']])).toEqual([
      [OTHER_HOME, true, 'stored'],
      [HOME_ID, false, 'stored'],
    ]);
    expect(host.stdout()).not.toContain('mhk1_');

    const text = testHost({ home });
    expect(await run(['context', 'list'], text)).toBe(EXIT_CODE.success);
    expect(text.stdout()).toContain(`* ${OTHER_HOME}:`);
    expect(text.stdout()).not.toContain('mhk1_');
  });

  test('show redacts the credential and defaults to the current context', async () => {
    await seed();
    const host = testHost({ home });
    expect(await run(['context', 'show'], host)).toBe(EXIT_CODE.success);
    expect(host.stdout()).toContain(`Context ${OTHER_HOME} (current)`);
    expect(host.stdout()).toContain('credential: stored (never printed)');
    expect(host.stdout()).not.toContain('mhk1_');
  });

  test('use switches the current context and survives a restart', async () => {
    await seed();
    expect(await run(['context', 'use', HOME_ID], testHost({ home }))).toBe(EXIT_CODE.success);
    // A new process reads the same files: nothing lives in memory or in the environment.
    expect((await readContexts(store)).current).toBe(HOME_ID);
    expect(await run(['context', 'use', 'missing'], testHost({ home }))).toBe(EXIT_CODE.usage);
  });

  test('remove deletes the context and its key, keeps the others and says the key is not revoked', async () => {
    await seed();
    const removedKey = await storedKey(OTHER_HOME);
    const host = testHost({ home });
    expect(await run(['context', 'remove', OTHER_HOME, '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()).toMatchObject({ removed: OTHER_HOME, was_current: true, revoked: false });

    const state = await readContexts(store);
    expect([...state.contexts.keys()]).toEqual([HOME_ID]);
    expect(state.current).toBeNull();
    expect(await readFile(join(store, CREDENTIALS_FILE), 'utf8')).not.toContain(removedKey);
  });

  test('an unknown action or a bad name is a usage failure', async () => {
    expect(await run(['context'], testHost({ home }))).toBe(EXIT_CODE.usage);
    expect(await run(['context', 'rename', 'a'], testHost({ home }))).toBe(EXIT_CODE.usage);
    expect(await run(['context', 'use', '../escape'], testHost({ home }))).toBe(EXIT_CODE.usage);
  });

  test('an empty store lists nothing and reads nothing outside it', async () => {
    const host = testHost({ home });
    expect(await run(['context', 'list', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()['contexts']).toEqual([]);
  });

  test('MIAKAPP_CONFIG_DIR relocates the store and must be absolute', async () => {
    const elsewhere = join(home, 'ci-store');
    const control = plane();
    const host = testHost({
      fetch: control.fetch,
      home,
      env: { MIAKAPP_CONFIG_DIR: elsewhere },
      ...secret(CODE),
    });
    expect(await run(['pair', '--issuer', ISSUER], host)).toBe(EXIT_CODE.success);
    expect((await readContexts(elsewhere)).contexts.has(HOME_ID)).toBe(true);
    expect((await readContexts(store)).contexts.size).toBe(0);

    const relative = testHost({ home, env: { MIAKAPP_CONFIG_DIR: 'relative/dir' } });
    expect(await run(['context', 'list'], relative)).toBe(EXIT_CODE.usage);
  });
});

describe('the store protects itself', () => {
  async function seeded(): Promise<void> {
    expect((await pair(plane(HOME_ID))).code).toBe(EXIT_CODE.success);
  }

  test.skipIf(process.platform === 'win32')('a credentials file readable by others is refused', async () => {
    await seeded();
    await chmod(join(store, CREDENTIALS_FILE), 0o644);
    const host = testHost({ files: standardProject(), fetch: plane().fetch, home });
    expect(await run(['status'], host)).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain('chmod 600');
  });

  test.skipIf(process.platform === 'win32')('a symbolic link in place of the credentials is refused', async () => {
    await seeded();
    const elsewhere = join(home, 'elsewhere.json');
    await writeFile(elsewhere, await readFile(join(store, CREDENTIALS_FILE)), { mode: 0o600 });
    await rm(join(store, CREDENTIALS_FILE));
    await symlink(elsewhere, join(store, CREDENTIALS_FILE));
    expect(await run(['context', 'list'], testHost({ home }))).toBe(EXIT_CODE.authorization);
  });

  test('a configuration that does not parse is refused, never rewritten', async () => {
    await seeded();
    await writeFile(join(store, CONFIG_FILE), '{"schema": ', { mode: 0o600 });
    const host = testHost({ home });
    expect(await run(['context', 'use', HOME_ID], host)).toBe(EXIT_CODE.authorization);
    expect(await readFile(join(store, CONFIG_FILE), 'utf8')).toBe('{"schema": ');
  });

  test('a credential swapped for another key is refused', async () => {
    await seeded();
    const path = join(store, CREDENTIALS_FILE);
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      credentials: Record<string, { home_key: string }>;
    };
    document.credentials[HOME_ID] = { home_key: homeKey() };
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });

    const host = testHost({ files: standardProject(), fetch: plane().fetch, home });
    expect(await run(['status'], host)).toBe(EXIT_CODE.authorization);
    expect(host.stderr()).toContain('is not the key');
  });

  test('concurrent writers never lose a context', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => mutateContexts(store, (state) => {
      const name = `home-${index}`;
      const key = homeKey();
      state.contexts.set(name, {
        name,
        issuer: ISSUER,
        homeId: `home-${index}x`,
        keyId: key.slice(5, 27),
        label: 'test',
        createdAt: new Date().toISOString(),
      });
      state.keys.set(name, key);
    })));
    const state = await readContexts(store);
    expect(state.contexts.size).toBe(12);
    expect([...state.credentials.values()].every((status) => status === 'stored')).toBe(true);
    // Atomic replacement leaves no temporary file and no lock behind.
    expect((await readdir(store)).sort()).toEqual([CONFIG_FILE, CREDENTIALS_FILE]);
  });

  test('a failed change writes nothing', async () => {
    await seeded();
    const before = await readFile(join(store, CONFIG_FILE), 'utf8');
    await expect(mutateContexts(store, () => {
      throw new Error('refused');
    })).rejects.toThrow('refused');
    expect(await readFile(join(store, CONFIG_FILE), 'utf8')).toBe(before);
    expect((await readdir(store)).sort()).toEqual([CONFIG_FILE, CREDENTIALS_FILE]);
  });

  test('a lock left by a crashed process is reclaimed once stale', async () => {
    await seeded();
    const lock = join(store, 'lock');
    await writeFile(lock, '999999\n');
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    expect(await run(['context', 'use', HOME_ID], testHost({ home }))).toBe(EXIT_CODE.success);
  });

  test.skipIf(process.platform === 'win32')('a loose store directory is tightened on the next write', async () => {
    await seeded();
    await chmod(store, 0o755);
    expect(await run(['context', 'use', HOME_ID], testHost({ home }))).toBe(EXIT_CODE.success);
    expect((await lstat(store)).mode & 0o777).toBe(0o700);
  });
});
