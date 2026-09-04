import { describe, expect, test } from 'bun:test';
import type {
  BrowserRelayCredentialRequest,
  ControlPlaneBrowserRelayCredentialProviderOptions,
} from '../src/browser-api.js';
import { createBrowserClientWithRuntime } from '../src/browser-client.js';
import { createControlPlaneBrowserRelayCredentialProvider } from '../src/browser-relay-credential-provider.js';
import { Opcode } from '../src/protocol/codec.js';
import { FakeRelay } from './fakes/relay.js';
import { FakeRuntime, flushMicrotasks } from './fakes/runtime.js';
import { sendUserBootstrap } from './fakes/user-relay.js';

const ENDPOINT = 'https://control.example.test/v1/user-relay-tokens:exchange';
const FIREBASE_ID_TOKEN = 'firebase.header.signature';
const APP_CHECK_TOKEN = 'appcheck.header.signature';
const ACCESS_TOKEN = 'miakapp.header.signature';

function successHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    pragma: 'no-cache',
  };
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'miakapp.user-relay-token/1',
    access_token: ACCESS_TOKEN,
    token_type: 'Bearer',
    expires_at_ms: Date.now() + 300_000,
    relay_url: 'wss://relay.example.test/miakapp/ws',
    ...overrides,
  };
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: successHeaders(),
    ...init,
  });
}

function fetcher(
  implementation: (input: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return implementation as typeof globalThis.fetch;
}

function options(
  fetchImplementation: (input: string, init: RequestInit) => Promise<Response>,
): ControlPlaneBrowserRelayCredentialProviderOptions {
  return {
    exchangeEndpoint: ENDPOINT,
    async getFirebaseIdToken() { return FIREBASE_ID_TOKEN; },
    async getAppCheckToken() { return APP_CHECK_TOKEN; },
    fetch: fetcher(fetchImplementation),
  };
}

function request(
  reason: BrowserRelayCredentialRequest['reason'] = 'initial',
  signal = new AbortController().signal,
): BrowserRelayCredentialRequest {
  return { homeId: 'test-home', reason, signal };
}

describe('control-plane browser relay credential provider', () => {
  test('performs one closed source exchange and returns only the atomic relay credential', async () => {
    const callbackRequests: BrowserRelayCredentialRequest[] = [];
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const provider = createControlPlaneBrowserRelayCredentialProvider({
      exchangeEndpoint: ENDPOINT,
      async getFirebaseIdToken(value) {
        callbackRequests.push(value);
        return FIREBASE_ID_TOKEN;
      },
      async getAppCheckToken(value) {
        callbackRequests.push(value);
        return APP_CHECK_TOKEN;
      },
      fetch: fetcher(async (input, init) => {
        calls.push({ input, init });
        return response(JSON.stringify(successBody()));
      }),
    });

    const result = await provider.getCredential(request('reauth'));
    expect(result).toEqual({
      relayUrl: 'wss://relay.example.test/miakapp/ws',
      accessToken: ACCESS_TOKEN,
      expiresAtMs: expect.any(Number),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FIREBASE_ID_TOKEN);
    expect(JSON.stringify(result)).not.toContain(APP_CHECK_TOKEN);
    expect(callbackRequests).toHaveLength(2);
    expect(callbackRequests[0]).toBe(callbackRequests[1]);
    expect(Object.isFrozen(callbackRequests[0])).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('missing exchange request');
    expect(call.input).toBe(ENDPOINT);
    expect(call.init.method).toBe('POST');
    const fetchInit = call.init as RequestInit & Record<string, unknown>;
    expect(fetchInit.cache).toBe('no-store');
    expect(fetchInit.credentials).toBe('omit');
    expect(fetchInit.redirect).toBe('error');
    expect(fetchInit.referrerPolicy).toBe('no-referrer');
    expect(new Headers(call.init.headers)).toEqual(new Headers({
      accept: 'application/json',
      authorization: `Bearer ${FIREBASE_ID_TOKEN}`,
      'content-type': 'application/json',
      'x-firebase-appcheck': APP_CHECK_TOKEN,
    }));
    expect(JSON.parse(call.init.body as string)).toEqual({
      home_id: 'test-home',
      reason: 'reauth',
    });
  });

  test('confines source tokens to HTTPS and puts only the exchanged token in HELLO', async () => {
    const provider = createControlPlaneBrowserRelayCredentialProvider(options(
      async () => response(JSON.stringify(successBody({
        relay_url: 'wss://relay.test/miakapp/ws',
      }))),
    ));
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: provider,
    }, runtime);

    const started = client.start();
    const connection = await relay.connectionAt(0);
    const hello = await connection.nextClientFrame(Opcode.Hello);
    expect(hello.payload[4]).toBe(ACCESS_TOKEN);
    expect(JSON.stringify(hello.payload)).not.toContain(FIREBASE_ID_TOKEN);
    expect(JSON.stringify(hello.payload)).not.toContain(APP_CHECK_TOKEN);
    sendUserBootstrap(connection);
    await started;
    await client.stop();
  });

  test('is inert at construction, performs no hidden retry, and sanitizes failures', async () => {
    const secret = `${FIREBASE_ID_TOKEN}:${APP_CHECK_TOKEN}`;
    let calls = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider(options(async () => {
      calls += 1;
      throw new Error(secret);
    }));
    expect(calls).toBe(0);
    const failure = await provider.getCredential(request()).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe('Error: Miakapp browser relay credential exchange failed');
    expect(String(failure)).not.toContain(secret);
  });

  test('rejects malformed configuration and request shapes before callbacks or network', async () => {
    const invalidConfigurations: ControlPlaneBrowserRelayCredentialProviderOptions[] = [
      { ...options(async () => response('{}')), exchangeEndpoint: ENDPOINT.replace('https:', 'http:') },
      { ...options(async () => response('{}')), exchangeEndpoint: `${ENDPOINT}?relay=other` },
      { ...options(async () => response('{}')), exchangeEndpoint: 'https://user@control.example.test/v1/user-relay-tokens:exchange' },
    ];
    for (const configuration of invalidConfigurations) {
      expect(() => createControlPlaneBrowserRelayCredentialProvider(configuration))
        .toThrow('Miakapp browser relay credential exchange failed');
    }
    expect(() => createControlPlaneBrowserRelayCredentialProvider({
      ...options(async () => response('{}')),
      unknown: true,
    } as ControlPlaneBrowserRelayCredentialProviderOptions))
      .toThrow('Miakapp browser relay credential exchange failed');
    const hostileConfiguration = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileConfiguration, 'exchangeEndpoint', {
      enumerable: true,
      get() { throw new Error(FIREBASE_ID_TOKEN); },
    });
    Object.defineProperty(hostileConfiguration, 'getFirebaseIdToken', {
      enumerable: true,
      value: async () => FIREBASE_ID_TOKEN,
    });
    Object.defineProperty(hostileConfiguration, 'getAppCheckToken', {
      enumerable: true,
      value: async () => APP_CHECK_TOKEN,
    });
    expect(() => createControlPlaneBrowserRelayCredentialProvider(
      hostileConfiguration as unknown as ControlPlaneBrowserRelayCredentialProviderOptions,
    )).toThrow('Miakapp browser relay credential exchange failed');

    let callbacks = 0;
    let calls = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider({
      exchangeEndpoint: ENDPOINT,
      async getFirebaseIdToken() { callbacks += 1; return FIREBASE_ID_TOKEN; },
      async getAppCheckToken() { callbacks += 1; return APP_CHECK_TOKEN; },
      fetch: fetcher(async () => { calls += 1; return response('{}'); }),
    });
    const invalidRequests = [
      { homeId: '../bad', reason: 'initial', signal: new AbortController().signal },
      { homeId: 'test-home', reason: 'other', signal: new AbortController().signal },
      { homeId: 'test-home', reason: 'initial', signal: {} },
      { ...request(), unknown: true },
    ];
    for (const invalid of invalidRequests) {
      await expect(provider.getCredential(invalid as BrowserRelayCredentialRequest))
        .rejects.toThrow('Miakapp browser relay credential exchange failed');
    }
    expect(callbacks).toBe(0);
    expect(calls).toBe(0);
  });

  test('rejects invalid source tokens before the next source or network boundary', async () => {
    let appCheckCalls = 0;
    let fetchCalls = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider({
      exchangeEndpoint: ENDPOINT,
      async getFirebaseIdToken() { return 'not a compact token'; },
      async getAppCheckToken() { appCheckCalls += 1; return APP_CHECK_TOKEN; },
      fetch: fetcher(async () => { fetchCalls += 1; return response('{}'); }),
    });
    await expect(provider.getCredential(request()))
      .rejects.toThrow('Miakapp browser relay credential exchange failed');
    expect(appCheckCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('rejects open, duplicate, reflected, stale, or mismatched response shapes', async () => {
    const valid = successBody();
    const malformedBodies = [
      JSON.stringify({ ...valid, unknown: true }),
      JSON.stringify({ ...valid, schema: 'other' }),
      JSON.stringify({ ...valid, access_token: 'not-a-compact-token' }),
      JSON.stringify({ ...valid, access_token: FIREBASE_ID_TOKEN }),
      JSON.stringify({ ...valid, access_token: APP_CHECK_TOKEN }),
      JSON.stringify({ ...valid, expires_at_ms: Date.now() }),
      JSON.stringify({ ...valid, expires_at_ms: Date.now() + 331_000 }),
      JSON.stringify({ ...valid, relay_url: 'ws://relay.example.test/ws' }),
      `{"schema":"miakapp.user-relay-token/1","schema":"miakapp.user-relay-token/1","access_token":"${ACCESS_TOKEN}","token_type":"Bearer","expires_at_ms":${Date.now() + 300_000},"relay_url":"wss://relay.example.test/ws"}`,
      `{"schema":"miakapp.user-relay-token/1","access_token":"${ACCESS_TOKEN}","token_type":"Bearer","expires_at_ms":${Date.now() + 300_000},"relay_url":"\\ud800"}`,
      'x'.repeat(65_537),
    ];
    for (const body of malformedBodies) {
      const provider = createControlPlaneBrowserRelayCredentialProvider(options(
        async () => response(body),
      ));
      await expect(provider.getCredential(request()))
        .rejects.toThrow('Miakapp browser relay credential exchange failed');
    }
  });

  test('requires a successful non-redirected no-store JSON response', async () => {
    const cases: Response[] = [
      new Response(JSON.stringify(successBody()), {
        status: 503,
        headers: successHeaders(),
      }),
      new Response(JSON.stringify(successBody()), {
        status: 200,
        headers: { 'content-type': 'application/json', pragma: 'no-cache' },
      }),
      new Response(JSON.stringify(successBody()), {
        status: 200,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain', pragma: 'no-cache' },
      }),
      new Response(JSON.stringify(successBody()), {
        status: 200,
        headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
      }),
    ];
    const redirected = response(JSON.stringify(successBody()));
    Object.defineProperty(redirected, 'redirected', { value: true });
    cases.push(redirected);
    for (const invalidResponse of cases) {
      const provider = createControlPlaneBrowserRelayCredentialProvider(options(
        async () => invalidResponse,
      ));
      await expect(provider.getCredential(request()))
        .rejects.toThrow('Miakapp browser relay credential exchange failed');
    }
  });

  test('coalesces only identical in-flight requests', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let callbacks = 0;
    let calls = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider({
      exchangeEndpoint: ENDPOINT,
      async getFirebaseIdToken() { callbacks += 1; return FIREBASE_ID_TOKEN; },
      async getAppCheckToken() { callbacks += 1; return APP_CHECK_TOKEN; },
      fetch: fetcher(async () => {
        calls += 1;
        await gate;
        return response(JSON.stringify(successBody()));
      }),
    });
    const signal = new AbortController().signal;
    const first = provider.getCredential(request('initial', signal));
    const second = provider.getCredential(request('initial', signal));
    await flushMicrotasks();
    expect(callbacks).toBe(2);
    expect(calls).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await provider.getCredential(request('reconnect', signal));
    await provider.getCredential(request('initial', new AbortController().signal));
    expect(calls).toBe(3);
  });

  test('settles promptly with the exact cancellation reason even when a callback ignores it', async () => {
    const controller = new AbortController();
    const cancellation = new Error('synthetic cancellation');
    let callbacks = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider({
      exchangeEndpoint: ENDPOINT,
      async getFirebaseIdToken() {
        callbacks += 1;
        return new Promise<string>(() => undefined);
      },
      async getAppCheckToken() { callbacks += 1; return APP_CHECK_TOKEN; },
      fetch: fetcher(async () => response('{}')),
    });
    const pending = provider.getCredential(request('initial', controller.signal));
    await flushMicrotasks();
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
    expect(callbacks).toBe(1);
  });

  test('cancels a response stream that ignores the fetch signal', async () => {
    const controller = new AbortController();
    const cancellation = new Error('synthetic stream cancellation');
    let cancellations = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider(options(async () => (
      new Response(new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(() => undefined); },
        cancel() { cancellations += 1; },
      }), { status: 200, headers: successHeaders() })
    )));
    const pending = provider.getCredential(request('initial', controller.signal));
    await flushMicrotasks();
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
    await flushMicrotasks();
    expect(cancellations).toBe(1);
  });

  test('cancels an unread response stream when its declared length is invalid', async () => {
    let cancellations = 0;
    const provider = createControlPlaneBrowserRelayCredentialProvider(options(async () => (
      new Response(new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(() => undefined); },
        cancel() {
          cancellations += 1;
          return new Promise<void>(() => undefined);
        },
      }), {
        status: 200,
        headers: { ...successHeaders(), 'content-length': '65537' },
      })
    )));
    await expect(provider.getCredential(request()))
      .rejects.toThrow('Miakapp browser relay credential exchange failed');
    expect(cancellations).toBe(1);
  });
});
