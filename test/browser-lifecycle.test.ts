import { describe, expect, test } from 'bun:test';
import type { BrowserClientLogRecord, FirebaseIdTokenRequest } from '../src/browser-api.js';
import { createBrowserClientWithRuntime } from '../src/browser-client.js';
import { Opcode } from '../src/protocol/codec.js';
import { FakeRelay } from './fakes/relay.js';
import { FakeRuntime, flushMicrotasks } from './fakes/runtime.js';
import {
  createBrowserTestHarness,
  sendUserBootstrap,
  startBrowserReady,
} from './fakes/user-relay.js';

describe('browser lifecycle', () => {
  test('binds role, token and home, then reaches readiness after complete bootstrap', async () => {
    const harness = createBrowserTestHarness();
    const statuses: string[] = [];
    harness.client.subscribe(({ current }) => statuses.push(current));
    const started = harness.client.start();
    const connection = await harness.relay.connectionAt(0);
    const hello = await connection.nextClientFrame(Opcode.Hello);
    expect(hello.payload).toEqual([1, 0, 0, 1, 'firebase-initial', ['test-home']]);
    expect(harness.client.status).toBe('authenticating');
    sendUserBootstrap(connection);
    const ready = await started;
    expect(ready.enrolled).toBe(true);
    expect(ready.coordinators[0]).toEqual({
      name: 'test-coordinator', generation: 4, status: 'connected',
    });
    expect(statuses).toEqual(['connecting', 'authenticating', 'synchronizing', 'ready']);
    await harness.client.stop();
  });

  test('publishes current enrollment and coordinator availability changes', async () => {
    const harness = createBrowserTestHarness();
    const { connection } = await startBrowserReady(harness);
    expect(harness.client.home.snapshot()).toMatchObject({
      enrolled: true,
      stale: false,
      coordinators: [{ name: 'test-coordinator', generation: 4, status: 'connected' }],
    });
    const observed: boolean[] = [];
    harness.client.home.subscribe((status) => observed.push(status.enrolled));
    connection.send({ opcode: Opcode.HomeStatus, payload: [false, []] });
    expect(observed).toEqual([true, false]);
    expect(harness.client.home.snapshot()).toMatchObject({
      enrolled: false, stale: false, coordinators: [],
    });
    connection.close(1006, 'synthetic loss');
    await flushMicrotasks();
    expect(harness.client.home.snapshot()?.stale).toBe(true);
    await harness.client.stop();
  });

  test('rejects a WELCOME outside the offered protocol version', async () => {
    const harness = createBrowserTestHarness();
    const failures: string[] = [];
    harness.client.errors.subscribe((failure) => failures.push(failure.kind));
    const started = harness.client.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    connection.send({
      opcode: Opcode.Welcome,
      payload: [2, 0, 41, connection.epoch, true, [], [262_144, 128, 256, 1_048_576], 2_000_000],
    });
    await flushMicrotasks();
    expect(harness.client.status).toBe('reconnecting');
    expect(failures).toContain('protocol');
    await harness.client.stop();
  });

  test('reauthenticates on the same socket from the verified lease', async () => {
    const harness = createBrowserTestHarness({ expiresAtMs: 1_010_000 });
    const { connection } = await startBrowserReady(harness);
    await harness.runtime.advanceBy(5_000);
    const reauth = await connection.nextClientFrame(Opcode.Reauth);
    expect(reauth.payload).toEqual([1, 'firebase-reauth']);
    connection.send({ opcode: Opcode.ReauthOk, payload: [1, 2_000_000] });
    await flushMicrotasks();
    expect(harness.tokenRequests.map(({ reason }) => reason)).toEqual(['initial', 'reauth']);
    expect(harness.relay.connectCount).toBe(1);
    expect(harness.client.status).toBe('ready');
    await harness.client.stop();
  });

  test('bounds a missing REAUTH response and reconnects', async () => {
    const harness = createBrowserTestHarness({ expiresAtMs: 1_040_000 });
    harness.runtime.queueRandom(0);
    const { connection } = await startBrowserReady(harness);
    await harness.runtime.advanceBy(20_000);
    await connection.nextClientFrame(Opcode.Reauth);
    await harness.runtime.advanceBy(10_000);
    expect(harness.relay.connectCount).toBe(2);
    expect(harness.client.status).toBe('authenticating');
    await harness.client.stop();
  });

  test('marks state stale and reacquires a token before reconnecting with full jitter', async () => {
    const harness = createBrowserTestHarness();
    harness.runtime.queueRandom(0);
    const { connection } = await startBrowserReady(harness);
    connection.close(1006, 'synthetic loss');
    await flushMicrotasks();
    expect(harness.client.status).toBe('reconnecting');
    expect(harness.client.state.snapshot()?.stale).toBe(true);
    await harness.runtime.advanceBy(0);
    const next = await harness.relay.connectionAt(1);
    const hello = await next.nextClientFrame(Opcode.Hello);
    expect(hello.payload[4]).toBe('firebase-reconnect');
    sendUserBootstrap(next, { revision: 1, state: { 'home.temperature': 22 } });
    await flushMicrotasks();
    expect(harness.client.status).toBe('ready');
    expect(harness.client.state.snapshot()?.values['home.temperature']).toBe(22);
    expect(harness.tokenRequests.map(({ reason }) => reason)).toEqual(['initial', 'reconnect']);
    await harness.client.stop();
  });

  test('resets reconnect backoff after each accepted WELCOME', async () => {
    const harness = createBrowserTestHarness();
    harness.runtime.queueRandom(0.5, 0.5);
    const started = harness.client.start();
    void started.catch(() => undefined);
    const first = await harness.relay.connectionAt(0);
    await first.nextClientFrame(Opcode.Hello);
    first.sendWelcome();
    await flushMicrotasks();
    first.close(1006, 'bootstrap interrupted');
    await flushMicrotasks();
    await harness.runtime.advanceBy(500);
    expect(harness.relay.connectCount).toBe(2);
    const second = await harness.relay.connectionAt(1);
    await second.nextClientFrame(Opcode.Hello);
    second.sendWelcome();
    await flushMicrotasks();
    second.close(1006, 'bootstrap interrupted again');
    await flushMicrotasks();
    await harness.runtime.advanceBy(500);
    expect(harness.relay.connectCount).toBe(3);
    await harness.client.stop();
  });

  test('bounds token acquisition and WELCOME phases', async () => {
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    let tokenRequests = 0;
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      relayUrl: 'wss://relay.test/ws',
      idTokenProvider: {
        async getIdToken() {
          tokenRequests += 1;
          return new Promise<string>(() => undefined);
        },
      },
    }, runtime);
    const started = client.start();
    void started.catch(() => undefined);
    await flushMicrotasks();
    await runtime.advanceBy(10_000);
    expect(tokenRequests).toBe(2);
    expect(relay.connectCount).toBe(0);
    await client.stop();

    const handshake = createBrowserTestHarness();
    const handshakeStart = handshake.client.start();
    void handshakeStart.catch(() => undefined);
    const connection = await handshake.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    await handshake.runtime.advanceBy(10_000);
    expect(handshake.relay.connectCount).toBe(2);
    expect(handshake.relay.openConnectionCount).toBe(1);
    await handshake.client.stop();
  });

  test('sanitizes provider failures and log records', async () => {
    const secret = 'firebase-secret-from-provider';
    const records: BrowserClientLogRecord[] = [];
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    const tokenRequests: FirebaseIdTokenRequest[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      relayUrl: 'wss://relay.test/ws',
      idTokenProvider: {
        async getIdToken(request) {
          tokenRequests.push(request);
          throw new Error(secret);
        },
      },
      logger: { write: (record) => records.push(record) },
    }, runtime);
    const failures: Error[] = [];
    client.errors.subscribe((failure) => failures.push(failure));
    const started = client.start();
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(JSON.stringify({ records, failures: failures.map((failure) => failure.message) }))
      .not.toContain(secret);
    expect(tokenRequests).toHaveLength(1);
    await client.stop();
    await expect(started).rejects.toMatchObject({ kind: 'cancelled' });
  });

  test('does not invoke the token provider after a connecting listener stops reentrantly', async () => {
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    let tokenRequests = 0;
    const statuses: string[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      relayUrl: 'wss://relay.test/ws',
      idTokenProvider: {
        async getIdToken() {
          tokenRequests += 1;
          return 'firebase-token';
        },
      },
    }, runtime);
    client.subscribe(({ current }) => {
      statuses.push(current);
      if (current === 'connecting') void client.stop();
    });

    const started = client.start();
    await expect(started).rejects.toMatchObject({ kind: 'cancelled' });
    await client.stop();

    expect(tokenRequests).toBe(0);
    expect(relay.connectCount).toBe(0);
    expect(statuses).toEqual(['connecting', 'stopping', 'stopped']);
  });

  test('does not resume synchronization after a home listener stops reentrantly', async () => {
    const harness = createBrowserTestHarness();
    const statuses: string[] = [];
    harness.client.subscribe(({ current }) => statuses.push(current));
    harness.client.home.subscribe(() => { void harness.client.stop(); });
    const started = harness.client.start();
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(connection);

    await expect(started).rejects.toMatchObject({ kind: 'cancelled' });
    await harness.client.stop();

    expect(statuses).toEqual(['connecting', 'authenticating', 'stopping', 'stopped']);
    expect(statuses).not.toContain('synchronizing');
    expect(statuses).not.toContain('ready');
  });

  test('does not reconnect after an error listener stops reentrantly', async () => {
    const harness = createBrowserTestHarness();
    const statuses: string[] = [];
    harness.client.subscribe(({ current }) => statuses.push(current));
    const { connection } = await startBrowserReady(harness);
    statuses.length = 0;
    harness.client.errors.subscribe(() => { void harness.client.stop(); });

    connection.close(1006, 'synthetic loss');
    await flushMicrotasks();
    await harness.client.stop();

    expect(statuses).toEqual(['stopping', 'stopped']);
    expect(harness.relay.connectCount).toBe(1);
  });

  test('treats a coordinator-only frame as a protocol failure', async () => {
    const harness = createBrowserTestHarness();
    const failures: Array<{ kind: string }> = [];
    harness.client.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startBrowserReady(harness);
    connection.send({
      opcode: Opcode.StateSetOk,
      payload: [1, connection.epoch, 2],
    });
    await flushMicrotasks();
    expect(failures.some(({ kind }) => kind === 'protocol')).toBe(true);
    await harness.client.stop();
  });

  test('validates and ignores an optional extension frame', async () => {
    const harness = createBrowserTestHarness();
    const failures: Array<{ kind: string }> = [];
    harness.client.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startBrowserReady(harness);
    connection.send({ opcode: 0x80, payload: [{ optional: true }] });
    await flushMicrotasks();
    expect(harness.client.status).toBe('ready');
    expect(failures).toEqual([]);
    await harness.client.stop();
  });
});
