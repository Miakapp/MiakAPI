import { describe, expect, test } from 'bun:test';
import {
  createHomeKeyAccessTokenProvider,
  type HomeKeyAccessTokenProviderOptions,
} from '../src/access-token-provider.js';
import type { AccessTokenRequest } from '../src/api.js';
import { createCoordinatorWithRuntime } from '../src/coordinator.js';
import { Opcode } from '../src/protocol/codec.js';
import { FakeRelay } from './fakes/relay.js';
import { FakeRuntime, flushMicrotasks } from './fakes/runtime.js';
import { configuration } from './helpers.js';

const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const HOME_KEY = `mhk1_${KEY_ID}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const ENDPOINT = 'https://control.example.test/v1/access-tokens:exchange';

function request(reason: AccessTokenRequest['reason'] = 'initial'): AccessTokenRequest {
  return {
    coordinatorName: 'automation',
    reason,
    signal: new AbortController().signal,
  };
}

function successHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
  };
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'miakapp.access-token/1',
    access_token: 'header.payload.signature',
    token_type: 'Bearer',
    expires_at_ms: Date.now() + 300_000,
    relay_url: 'wss://relay.example.test/miakapp/ws',
    key: { id: KEY_ID, label: 'Synthetic coordinator' },
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

describe('Home Key access-token provider', () => {
  test('performs one closed exchange and returns only the SDK token boundary', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const provider = createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      async fetch(input, init) {
        calls.push({ input, init });
        return response(JSON.stringify(successBody()));
      },
    });
    const result = await provider.getAccessToken(request('reauth'));
    expect(result).toEqual({
      relayUrl: 'wss://relay.example.test/miakapp/ws',
      token: 'header.payload.signature',
      expiresAtMs: expect.any(Number),
    });
    expect(Object.isFrozen(result)).toBe(true);
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
      authorization: `Bearer ${HOME_KEY}`,
      'content-type': 'application/json',
    }));
    expect(JSON.parse(call.init.body as string)).toEqual({
      purpose: 'relay',
      role: 'coordinator',
      coordinator_name: 'automation',
      reason: 'reauth',
    });
  });

  test('feeds initial and scheduled REAUTH demands without a second connection loop', async () => {
    const now = Date.now();
    const reasons: string[] = [];
    const provider = createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      async fetch(_input, init) {
        const body = JSON.parse(init.body as string) as { reason: string };
        reasons.push(body.reason);
        return response(JSON.stringify(successBody({
          access_token: `header.${body.reason}.signature`,
          expires_at_ms: now + 60_000,
        })));
      },
    });
    const relay = new FakeRelay({ expiresAtMs: now + 1_000_000, coordinatorName: 'automation' });
    const runtime = new FakeRuntime(relay, now);
    const coordinator = createCoordinatorWithRuntime({
      name: 'automation',
      accessTokenProvider: provider,
    }, runtime);
    coordinator.configure(configuration());
    const started = coordinator.start();
    const connection = await relay.connectionAt(0);
    const hello = await connection.nextClientFrame(Opcode.Hello);
    expect(hello.payload[4]).toBe('header.initial.signature');
    await connection.acknowledgeDeclarations();
    await started;

    await runtime.advanceBy(30_000);
    const reauth = await connection.nextClientFrame(Opcode.Reauth);
    expect(reauth.payload[1]).toBe('header.reauth.signature');
    connection.send({
      opcode: Opcode.ReauthOk,
      payload: [reauth.payload[0] ?? 1, now + 60_000],
    });
    await flushMicrotasks();

    expect(reasons).toEqual(['initial', 'reauth']);
    expect(relay.connections).toHaveLength(1);
    expect(relay.socketHighWater).toBe(1);
    await coordinator.stop();
  });

  test('is inert at construction and performs no hidden retry', async () => {
    let calls = 0;
    const provider = createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      async fetch() {
        calls += 1;
        return new Response('unavailable', { status: 503 });
      },
    });
    expect(calls).toBe(0);
    await expect(provider.getAccessToken(request())).rejects.toThrow('Miakapp access-token exchange failed');
    expect(calls).toBe(1);
  });

  test('propagates SDK cancellation without retaining the Home Key in an error', async () => {
    const controller = new AbortController();
    const cancellation = new Error('synthetic cancellation');
    const provider = createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error(HOME_KEY)), { once: true });
      }),
    });
    const pending = provider.getAccessToken({
      coordinatorName: 'automation',
      reason: 'initial',
      signal: controller.signal,
    });
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
  });

  test('rejects malformed configuration before network access', () => {
    const cases: HomeKeyAccessTokenProviderOptions[] = [
      { exchangeEndpoint: 'http://control.example.test/v1/access-tokens:exchange', homeKey: HOME_KEY },
      { exchangeEndpoint: `${ENDPOINT}?redirect=true`, homeKey: HOME_KEY },
      { exchangeEndpoint: 'https://user@control.example.test/v1/access-tokens:exchange', homeKey: HOME_KEY },
      { exchangeEndpoint: ENDPOINT, homeKey: 'mhk1_invalid' },
      { exchangeEndpoint: ENDPOINT, homeKey: `${HOME_KEY}=` },
    ];
    for (const options of cases) {
      expect(() => createHomeKeyAccessTokenProvider(options)).toThrow('Miakapp access-token exchange failed');
    }
    expect(() => createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      unknown: true,
    } as HomeKeyAccessTokenProviderOptions)).toThrow('Miakapp access-token exchange failed');
  });

  test('rejects open, duplicate, unsafe, stale, or mismatched response shapes', async () => {
    const valid = successBody();
    const malformedBodies: string[] = [
      JSON.stringify({ ...valid, unknown: true }),
      JSON.stringify({ ...valid, schema: 'other' }),
      JSON.stringify({ ...valid, access_token: 'not-a-compact-token' }),
      JSON.stringify({ ...valid, expires_at_ms: Date.now() }),
      JSON.stringify({ ...valid, expires_at_ms: Date.now() + 331_000 }),
      JSON.stringify({ ...valid, relay_url: 'ws://relay.example.test/ws' }),
      JSON.stringify({ ...valid, key: { id: 'AQEBAQEBAQEBAQEBAQEBAQ', label: 'Other' } }),
      JSON.stringify({ ...valid, key: { id: KEY_ID, label: 'line\nbreak' } }),
      `{"schema":"miakapp.access-token/1","schema":"miakapp.access-token/1","access_token":"header.payload.signature","token_type":"Bearer","expires_at_ms":${Date.now() + 300_000},"relay_url":"wss://relay.example.test/ws","key":{"id":"${KEY_ID}","label":"Synthetic"}}`,
      `{"schema":"miakapp.access-token/1","access_token":"header.payload.signature","token_type":"Bearer","expires_at_ms":${Date.now() + 300_000},"relay_url":"wss://relay.example.test/ws","key":{"id":"${KEY_ID}","label":"\\ud800"}}`,
      'x'.repeat(65_537),
    ];
    for (const body of malformedBodies) {
      const provider = createHomeKeyAccessTokenProvider({
        exchangeEndpoint: ENDPOINT,
        homeKey: HOME_KEY,
        fetch: async () => response(body),
      });
      await expect(provider.getAccessToken(request())).rejects.toThrow('Miakapp access-token exchange failed');
    }
  });

  test('requires the closed no-store response headers', async () => {
    const headerCases: Array<Record<string, string>> = [
      { 'content-type': 'application/json', pragma: 'no-cache', 'referrer-policy': 'no-referrer' },
      { 'cache-control': 'no-store', 'content-type': 'text/plain', pragma: 'no-cache', 'referrer-policy': 'no-referrer' },
      { 'cache-control': 'no-store', 'content-type': 'application/json', 'referrer-policy': 'no-referrer' },
      { 'cache-control': 'no-store', 'content-type': 'application/json', pragma: 'no-cache' },
    ];
    for (const headers of headerCases) {
      const provider = createHomeKeyAccessTokenProvider({
        exchangeEndpoint: ENDPOINT,
        homeKey: HOME_KEY,
        fetch: async () => new Response(JSON.stringify(successBody()), { status: 200, headers }),
      });
      await expect(provider.getAccessToken(request())).rejects.toThrow('Miakapp access-token exchange failed');
    }
  });

  test('keeps Home Key material out of every public failure', async () => {
    const networkProvider = createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      fetch: async () => { throw new Error(`failed with ${HOME_KEY}`); },
    });
    const responseProvider = createHomeKeyAccessTokenProvider({
      exchangeEndpoint: ENDPOINT,
      homeKey: HOME_KEY,
      fetch: async () => Object.defineProperty({}, 'status', {
        get: () => { throw new Error(`failed with ${HOME_KEY}`); },
      }) as Response,
    });
    for (const provider of [networkProvider, responseProvider]) {
      const failure = await provider.getAccessToken(request()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(HOME_KEY);
    }
  });
});
