// End-to-end: a resident's browser client reaches a real coordinator over a
// WebRTC DataChannel on loopback, with no relay and no control plane at all
// (the home's internet link is down). node-datachannel's polyfill plays the
// browser's RTCPeerConnection.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationCallError, createCoordinator } from '../dist/index.js';
import { createBrowserClient } from '../dist/browser.js';
import { issueTicket, loadDirectIdentity } from '../dist/internal/direct-identity.js';

const polyfill = await import('node-datachannel/polyfill').catch(() => undefined);
const directory = mkdtempSync(join(tmpdir(), 'miakapi-direct-'));
after(() => rmSync(directory, { recursive: true, force: true }));

const offline = {
  getAccessToken: () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('offline')), 50)),
};

test('a resident uses the home through the direct transport without the internet', { skip: polyfill === undefined, timeout: 30_000 }, async () => {
  (globalThis as Record<string, unknown>).RTCPeerConnection = polyfill!.RTCPeerConnection;
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const coordinator = createCoordinator({
    name: 'house',
    accessTokenProvider: offline,
    direct: { directory, port, hosts: ['127.0.0.1'] },
  });
  let lamp = false;
  coordinator.configure({
    state: { 'lamp.on': false, 'secret.code': '1234' },
    stateAccess: [{ userId: 'alice', patterns: ['lamp.*'] }],
    events: [],
    eventAccess: [],
    functions: {
      async 'lamp.set'(call) {
        const on = (call.arguments as { on?: unknown }).on;
        if (typeof on !== 'boolean') throw new ApplicationCallError(2001, 'on must be a boolean');
        lamp = on;
        await coordinator.state.set([{ path: 'lamp.on', value: on }]);
        return { on, by: call.source.id };
      },
    },
  });
  void coordinator.start().catch(() => undefined);

  // What alice received through the relay the last time she was online.
  const record = recordFor('alice', port);
  await new Promise((resolve) => setTimeout(resolve, 300));

  let saved: unknown = record;
  const client = createBrowserClient({
    homeId: 'home-1',
    credentialProvider: { getCredential: () => new Promise<never>(() => undefined) },
    direct: { load: () => saved, save: (value) => { saved = value; } },
  });
  const started = performance.now();
  await client.start();
  const openMs = performance.now() - started;
  assert.equal(client.transport, 'direct');
  assert.ok(openMs < 2_000);
  assert.deepEqual({ ...client.state.snapshot()?.values }, { 'lamp.on': false });

  const changed = new Promise<unknown>((resolve) => {
    const stop = client.state.subscribe((snapshot) => {
      if (snapshot.values['lamp.on'] === true) { stop(); resolve(snapshot.values); }
    });
  });
  const call = client.calls.start({ function: 'lamp.set', arguments: { on: true }, timeoutMs: 5_000 });
  assert.deepEqual(await call.result, { on: true, by: 'alice' });
  assert.deepEqual({ ...(await changed as object) }, { 'lamp.on': true });
  assert.equal(lamp, true);

  const refused = client.calls.start({ function: 'lamp.set', arguments: { on: 'yes' }, timeoutMs: 5_000 });
  await assert.rejects(refused.result, (error: { code?: unknown }) => error.code === 2001);

  // The ticket was renewed over the direct session itself.
  await waitFor(async () => (saved !== record ? saved : undefined));

  await client.stop();
  await coordinator.stop();
});

test('a forged ticket is refused', { skip: polyfill === undefined, timeout: 30_000 }, async () => {
  (globalThis as Record<string, unknown>).RTCPeerConnection = polyfill!.RTCPeerConnection;
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const coordinator = createCoordinator({
    name: 'house',
    accessTokenProvider: offline,
    direct: { directory, port, hosts: ['127.0.0.1'] },
  });
  coordinator.configure({ state: {}, stateAccess: [], events: [], eventAccess: [], functions: {} });
  void coordinator.start().catch(() => undefined);
  const record = recordFor('mallory', port);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Same signature, someone else's identity in the claims.
  const [prefix, body, mac] = String(record.ticket).split('.');
  const claims = JSON.parse(Buffer.from(body as string, 'base64url').toString('utf8')) as Record<string, unknown>;
  const forgedBody = Buffer.from(JSON.stringify({ ...claims, u: 'alice' })).toString('base64url');
  const forged = { ...record, ticket: `${prefix}.${forgedBody}.${mac}` };
  let saved: unknown = forged;
  const client = createBrowserClient({
    homeId: 'home-1',
    credentialProvider: { getCredential: () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('offline')), 300)) },
    direct: { load: () => saved, save: (value) => { saved = value; } },
  });
  const failures: string[] = [];
  client.errors.subscribe((failure) => failures.push(failure.kind));
  void client.start().catch(() => undefined);
  await waitFor(async () => (failures.length > 0 ? true : undefined));
  assert.notEqual(client.status, 'ready');
  await client.stop();
  await coordinator.stop();
});

function recordFor(userId: string, port: number): Record<string, unknown> {
  const identity = loadDirectIdentity(directory);
  const expiresAtMs = Date.now() + 86_400_000;
  return {
    v: 1, coordinator: 'house', hosts: ['127.0.0.1'], port,
    fingerprint: identity.fingerprint, pwd: identity.pwd, expiresAtMs,
    ticket: issueTicket(identity.ticketKey, { userId, verifiedEmail: null, expiresAtMs }),
  };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

test('a home with two coordinators is aggregated directly, and opens partially when one is down', { skip: polyfill === undefined, timeout: 30_000 }, async () => {
  (globalThis as Record<string, unknown>).RTCPeerConnection = polyfill!.RTCPeerConnection;
  const base = 20_000 + Math.floor(Math.random() * 20_000);
  const make = (name: string, port: number, dir: string, path: string, fn: string) => {
    const coordinator = createCoordinator({
      name,
      accessTokenProvider: offline,
      direct: { directory: dir, port, hosts: ['127.0.0.1'] },
    });
    coordinator.configure({
      state: { [path]: false },
      stateAccess: [{ userId: 'alice', patterns: [path] }],
      events: [],
      eventAccess: [],
      functions: {
        async [fn](call) {
          const on = (call.arguments as { on: boolean }).on;
          await coordinator.state.set([{ path, value: on }]);
          return { by: name };
        },
      },
    });
    void coordinator.start().catch(() => undefined);
    return coordinator;
  };
  const dirA = join(directory, 'a');
  const dirB = join(directory, 'b');
  const house = make('house', base, dirA, 'heating.on', 'heating.set');
  const lamps = make('lamps', base + 1, dirB, 'lamp.on', 'lamp.set');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const recordAt = (dir: string, name: string, port: number) => {
    const identity = loadDirectIdentity(dir);
    const expiresAtMs = Date.now() + 86_400_000;
    return {
      v: 1, coordinator: name, hosts: ['127.0.0.1'], port, fingerprint: identity.fingerprint, pwd: identity.pwd, expiresAtMs,
      ticket: issueTicket(identity.ticketKey, { userId: 'alice', verifiedEmail: null, expiresAtMs }),
    };
  };
  let saved: unknown = {
    v: 2,
    expected: ['house', 'lamps'],
    records: { house: recordAt(dirA, 'house', base), lamps: recordAt(dirB, 'lamps', base + 1) },
  };
  const options = {
    homeId: 'home-1',
    credentialProvider: { getCredential: () => new Promise<never>(() => undefined) },
    direct: { load: () => saved, save: (value: unknown) => { saved = value; } },
  };
  const client = createBrowserClient(options);
  const ready = await client.start();
  assert.equal(client.transport, 'direct');
  assert.deepEqual(ready.coordinators.map((entry) => entry.name), ['house', 'lamps']);
  assert.deepEqual({ ...client.state.snapshot()?.values }, { 'heating.on': false, 'lamp.on': false });
  const both = new Promise<void>((resolve) => {
    const stop = client.state.subscribe((snapshot) => {
      if (snapshot.values['heating.on'] === true && snapshot.values['lamp.on'] === true) { stop(); resolve(); }
    });
  });
  assert.deepEqual(await client.calls.start({ function: 'lamp.set', arguments: { on: true }, timeoutMs: 5_000 }).result, { by: 'lamps' });
  assert.deepEqual(await client.calls.start({ function: 'heating.set', arguments: { on: true }, timeoutMs: 5_000 }).result, { by: 'house' });
  await both;
  // Both tickets were renewed, and the list of coordinators kept.
  await waitFor(async () => {
    const value = saved as { expected: string[]; records: Record<string, { ticket: string }> };
    return value.expected.length === 2 && Object.keys(value.records).length === 2 ? true : undefined;
  });
  await client.stop();

  // The lamps coordinator is down (and there is no internet): the rest of the home still opens.
  await lamps.stop();
  const partial = createBrowserClient(options);
  const partialReady = await partial.start();
  assert.equal(partial.transport, 'direct');
  assert.deepEqual(partialReady.coordinators.map((entry) => entry.name), ['house']);
  assert.deepEqual({ ...partial.state.snapshot()?.values }, { 'heating.on': true });
  assert.deepEqual((saved as { expected: string[] }).expected, ['house', 'lamps']);
  await partial.stop();
  await house.stop();
});
