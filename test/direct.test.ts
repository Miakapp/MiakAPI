// End-to-end: a resident's browser client reaches a real coordinator over a
// WebRTC DataChannel on loopback, with no relay and no control plane at all
// (the home's internet link is down). node-datachannel's polyfill plays the
// browser's RTCPeerConnection.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationCallError, createCoordinator } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { issueTicket, loadDirectIdentity } from '../src/internal/direct-identity.js';

const polyfill = await import('node-datachannel/polyfill').catch(() => undefined);
const directory = mkdtempSync(join(tmpdir(), 'miakapi-direct-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const offline = {
  getAccessToken: () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('offline')), 50)),
};

test.skipIf(polyfill === undefined)('a resident uses the home through the direct transport without the internet', async () => {
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
  expect(client.transport).toBe('direct');
  expect(openMs).toBeLessThan(2_000);
  expect(client.state.snapshot()?.values).toEqual({ 'lamp.on': false });

  const changed = new Promise<unknown>((resolve) => {
    const stop = client.state.subscribe((snapshot) => {
      if (snapshot.values['lamp.on'] === true) { stop(); resolve(snapshot.values); }
    });
  });
  const call = client.calls.start({ function: 'lamp.set', arguments: { on: true }, timeoutMs: 5_000 });
  expect(await call.result).toEqual({ on: true, by: 'alice' });
  expect(await changed).toEqual({ 'lamp.on': true });
  expect(lamp).toBe(true);

  const refused = client.calls.start({ function: 'lamp.set', arguments: { on: 'yes' }, timeoutMs: 5_000 });
  await expect(refused.result).rejects.toMatchObject({ code: 2001 });

  // The ticket was renewed over the direct session itself.
  await waitFor(async () => (saved !== record ? saved : undefined));

  await client.stop();
  await coordinator.stop();
}, 20_000);

test.skipIf(polyfill === undefined)('a forged ticket is refused', async () => {
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
  const forged = { ...record, ticket: String(record.ticket).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) };
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
  expect(client.status).not.toBe('ready');
  await client.stop();
  await coordinator.stop();
}, 20_000);

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
