import { describe, expect, test } from 'bun:test';
import type {
  BrowserClientLogRecord,
  BrowserRelayCredentialRequest,
} from '../src/browser-api.js';
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
    expect(hello.payload).toEqual([1, 0, 0, 1, 'user.initial.signature', ['test-home']]);
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

  test('waits for a failed WELCOME transport to close before reconnecting', async () => {
    const harness = createBrowserTestHarness();
    harness.runtime.queueRandom(0);
    const started = harness.client.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    const oldTransport = connection.deferClientTermination();
    connection.send({
      opcode: Opcode.Welcome,
      payload: [2, 0, 41, connection.epoch, true, [], [262_144, 128, 256, 1_048_576], 2_000_000],
    });
    await flushMicrotasks();
    expect(harness.client.status).toBe('reconnecting');
    expect(harness.relay.connectCount).toBe(1);
    expect(harness.relay.openConnectionCount).toBe(1);

    oldTransport.release();
    await flushMicrotasks();
    await harness.runtime.advanceBy(0);
    const replacement = await harness.relay.connectionAt(1);
    await replacement.nextClientFrame(Opcode.Hello);
    expect(harness.relay.socketHighWater).toBe(1);
    await harness.client.stop();
  });

  test('fails closed when a missing WELCOME transport remains closing', async () => {
    const harness = createBrowserTestHarness();
    const failures: string[] = [];
    harness.client.errors.subscribe(({ kind }) => failures.push(kind));
    const started = harness.client.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    const oldTransport = connection.deferClientTermination();

    await harness.runtime.advanceBy(10_000);
    expect(harness.client.status).toBe('reconnecting');
    expect(harness.relay.connectCount).toBe(1);
    expect(harness.relay.openConnectionCount).toBe(1);
    expect(failures).toEqual(['unavailable']);

    await harness.runtime.advanceBy(9_999);
    expect(harness.client.status).toBe('reconnecting');
    expect(harness.relay.connectCount).toBe(1);
    expect(failures).toEqual(['unavailable']);

    await harness.runtime.advanceBy(1);
    expect(harness.client.status).toBe('stopped');
    expect(harness.relay.connectCount).toBe(1);
    expect(failures).toEqual(['unavailable', 'unavailable']);

    oldTransport.release();
    await flushMicrotasks();
    expect(harness.relay.openConnectionCount).toBe(0);
  });

  test('reauthenticates on the same socket from the verified lease', async () => {
    const harness = createBrowserTestHarness({ expiresAtMs: 1_010_000 });
    const { connection } = await startBrowserReady(harness);
    await harness.runtime.advanceBy(5_000);
    const reauth = await connection.nextClientFrame(Opcode.Reauth);
    expect(reauth.payload).toEqual([1, 'user.reauth.signature']);
    connection.send({ opcode: Opcode.ReauthOk, payload: [1, 2_000_000] });
    await flushMicrotasks();
    expect(harness.credentialRequests.map(({ reason }) => reason)).toEqual(['initial', 'reauth']);
    expect(harness.relay.connectCount).toBe(1);
    expect(harness.client.status).toBe('ready');
    await harness.client.stop();
  });

  test('hands an issued credential to a changed relay without reexchange or old-socket exposure', async () => {
    const relay = new FakeRelay({ autoWelcome: false, expiresAtMs: 1_010_000 });
    const runtime = new FakeRuntime(relay);
    const requests: BrowserRelayCredentialRequest[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential(request) {
          requests.push(request);
          return request.reason === 'initial'
            ? {
              relayUrl: 'wss://old-relay.test/miakapp/ws',
              accessToken: 'user.initial.signature',
              expiresAtMs: 1_010_000,
            }
            : {
              relayUrl: 'wss://new-relay.test/miakapp/ws',
              accessToken: 'user.handoff.signature',
              expiresAtMs: 1_100_000,
            };
        },
      },
    }, runtime);

    const started = client.start();
    const oldConnection = await relay.connectionAt(0);
    const oldHello = await oldConnection.nextClientFrame(Opcode.Hello);
    expect(oldHello.payload[4]).toBe('user.initial.signature');
    sendUserBootstrap(oldConnection);
    await started;

    const oldTransport = oldConnection.deferClientTermination();
    await runtime.advanceBy(5_000);
    expect(relay.connectCount).toBe(1);
    expect(relay.openConnectionCount).toBe(1);
    expect(client.status).toBe('reconnecting');
    expect(client.state.snapshot()?.stale).toBe(true);

    oldTransport.release();
    await flushMicrotasks();
    const replacement = await relay.connectionAt(1);
    const replacementHello = await replacement.nextClientFrame(Opcode.Hello);
    expect(replacementHello.payload[4]).toBe('user.handoff.signature');
    expect(oldConnection.queuedClientFrameCount).toBe(0);
    expect(requests.map(({ reason }) => reason)).toEqual(['initial', 'reauth']);
    expect(relay.connectUrls).toEqual([
      'wss://old-relay.test/miakapp/ws',
      'wss://new-relay.test/miakapp/ws',
    ]);
    expect(relay.socketHighWater).toBe(1);
    expect(client.state.snapshot()?.stale).toBe(true);

    sendUserBootstrap(replacement, { revision: 2, state: { 'home.temperature': 24 } });
    await flushMicrotasks();
    expect(client.status).toBe('ready');
    expect(client.state.snapshot()?.values['home.temperature']).toBe(24);
    await client.stop();
  });

  test('fails closed when a previous relay transport cannot close during handoff', async () => {
    const relay = new FakeRelay({ autoWelcome: false, expiresAtMs: 1_010_000 });
    const runtime = new FakeRuntime(relay);
    const failures: string[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential({ reason }) {
          return {
            relayUrl: reason === 'initial'
              ? 'wss://old-relay.test/miakapp/ws'
              : 'wss://new-relay.test/miakapp/ws',
            accessToken: `user.${reason}.signature`,
            expiresAtMs: 1_100_000,
          };
        },
      },
    }, runtime);
    client.errors.subscribe(({ kind }) => failures.push(kind));

    const started = client.start();
    const oldConnection = await relay.connectionAt(0);
    await oldConnection.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(oldConnection);
    await started;

    const oldTransport = oldConnection.deferClientTermination();
    await runtime.advanceBy(5_000);
    expect(client.status).toBe('reconnecting');
    expect(failures).toEqual([]);
    await runtime.advanceBy(9_999);
    expect(relay.connectCount).toBe(1);
    expect(relay.openConnectionCount).toBe(1);
    expect(client.status).toBe('reconnecting');
    expect(failures).toEqual([]);

    await runtime.advanceBy(1);
    expect(relay.connectCount).toBe(1);
    expect(client.status).toBe('stopped');
    expect(failures).toEqual(['unavailable']);

    oldTransport.release();
    await flushMicrotasks();
    expect(relay.openConnectionCount).toBe(0);
  });

  test('waits for a failed relay transport before reconnecting to a changed URL', async () => {
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    runtime.queueRandom(0);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential({ reason }) {
          return {
            relayUrl: reason === 'initial'
              ? 'wss://old-relay.test/miakapp/ws'
              : 'wss://new-relay.test/miakapp/ws',
            accessToken: `user.${reason}.signature`,
            expiresAtMs: 2_000_000,
          };
        },
      },
    }, runtime);

    const started = client.start();
    const oldConnection = await relay.connectionAt(0);
    await oldConnection.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(oldConnection);
    await started;

    const oldTransport = oldConnection.deferClientTermination();
    oldConnection.send({ opcode: Opcode.ReauthOk, payload: [999, 2_000_000] });
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(client.state.snapshot()?.stale).toBe(true);
    expect(relay.connectCount).toBe(1);
    expect(relay.openConnectionCount).toBe(1);

    oldTransport.release();
    await flushMicrotasks();
    await runtime.advanceBy(0);
    const replacement = await relay.connectionAt(1);
    const replacementHello = await replacement.nextClientFrame(Opcode.Hello);
    expect(replacementHello.payload[4]).toBe('user.reconnect.signature');
    expect(relay.connectUrls).toEqual([
      'wss://old-relay.test/miakapp/ws',
      'wss://new-relay.test/miakapp/ws',
    ]);
    expect(relay.socketHighWater).toBe(1);

    sendUserBootstrap(replacement, { revision: 2 });
    await flushMicrotasks();
    await client.stop();
  });

  test('fails closed when a failed relay transport cannot close before reconnect', async () => {
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    const failures: string[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential({ reason }) {
          return {
            relayUrl: reason === 'initial'
              ? 'wss://old-relay.test/miakapp/ws'
              : 'wss://new-relay.test/miakapp/ws',
            accessToken: `user.${reason}.signature`,
            expiresAtMs: 2_000_000,
          };
        },
      },
    }, runtime);
    client.errors.subscribe(({ kind }) => failures.push(kind));

    const started = client.start();
    const oldConnection = await relay.connectionAt(0);
    await oldConnection.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(oldConnection);
    await started;

    const oldTransport = oldConnection.deferClientTermination();
    oldConnection.send({ opcode: Opcode.ReauthOk, payload: [999, 2_000_000] });
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(failures).toEqual(['protocol']);

    await runtime.advanceBy(9_999);
    expect(relay.connectCount).toBe(1);
    expect(relay.openConnectionCount).toBe(1);
    expect(client.status).toBe('reconnecting');
    expect(failures).toEqual(['protocol']);

    await runtime.advanceBy(1);
    expect(relay.connectCount).toBe(1);
    expect(client.status).toBe('stopped');
    expect(failures).toEqual(['protocol', 'unavailable']);

    oldTransport.release();
    await flushMicrotasks();
    expect(relay.openConnectionCount).toBe(0);
  });

  test('rejects a credential that expires while the relay handshake is pending', async () => {
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential() {
          return {
            relayUrl: 'wss://relay.test/miakapp/ws',
            accessToken: 'user.expiring.signature',
            expiresAtMs: 1_000_001,
          };
        },
      },
    }, runtime);
    const started = client.start();
    void started.catch(() => undefined);
    const connection = await relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    await runtime.advanceBy(1);
    connection.sendWelcome();
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(relay.openConnectionCount).toBe(0);
    await client.stop();
  });

  test('rejects a REAUTH lease that exceeds the credential returned by the provider', async () => {
    const relay = new FakeRelay({ autoWelcome: false, expiresAtMs: 1_010_000 });
    const runtime = new FakeRuntime(relay);
    runtime.queueRandom(0);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential({ reason }) {
          return {
            relayUrl: 'wss://relay.test/miakapp/ws',
            accessToken: `user.${reason}.signature`,
            expiresAtMs: reason === 'initial' ? 1_010_000 : 1_020_000,
          };
        },
      },
    }, runtime);
    const failures: string[] = [];
    client.errors.subscribe(({ kind }) => failures.push(kind));
    const started = client.start();
    const connection = await relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(connection);
    await started;

    await runtime.advanceBy(5_000);
    const reauth = await connection.nextClientFrame(Opcode.Reauth);
    connection.send({ opcode: Opcode.ReauthOk, payload: [reauth.payload[0] ?? 1, 1_020_001] });
    await flushMicrotasks();
    expect(failures).toContain('protocol');
    expect(client.status).toBe('reconnecting');
    await client.stop();
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
    expect(hello.payload[4]).toBe('user.reconnect.signature');
    sendUserBootstrap(next, { revision: 1, state: { 'home.temperature': 22 } });
    await flushMicrotasks();
    expect(harness.client.status).toBe('ready');
    expect(harness.client.state.snapshot()?.values['home.temperature']).toBe(22);
    expect(harness.credentialRequests.map(({ reason }) => reason)).toEqual(['initial', 'reconnect']);
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

  test('bounds credential acquisition and WELCOME phases', async () => {
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    let credentialRequests = 0;
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential() {
          credentialRequests += 1;
          return new Promise<never>(() => undefined);
        },
      },
    }, runtime);
    const started = client.start();
    void started.catch(() => undefined);
    await flushMicrotasks();
    await runtime.advanceBy(10_000);
    expect(credentialRequests).toBe(2);
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
    const secret = 'source-secret-from-provider';
    const records: BrowserClientLogRecord[] = [];
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    const credentialRequests: BrowserRelayCredentialRequest[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential(request) {
          credentialRequests.push(request);
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
    expect(credentialRequests).toHaveLength(1);
    await client.stop();
    await expect(started).rejects.toMatchObject({ kind: 'cancelled' });
  });

  test('rejects malformed provider credentials before opening a socket without echoing them', async () => {
    const secret = 'source credential that must not escape';
    const records: BrowserClientLogRecord[] = [];
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential() {
          return {
            relayUrl: 'ws://relay.test/ws',
            accessToken: secret,
            expiresAtMs: 2_000_000,
          };
        },
      },
      logger: { write: (record) => records.push(record) },
    }, runtime);
    const failures: Error[] = [];
    client.errors.subscribe((failure) => failures.push(failure));
    const started = client.start();
    void started.catch(() => undefined);
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(relay.connectCount).toBe(0);
    expect(JSON.stringify({ records, failures: failures.map(({ message }) => message) }))
      .not.toContain(secret);
    await client.stop();
  });

  test('does not invoke the credential provider after a connecting listener stops reentrantly', async () => {
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    let credentialRequests = 0;
    const statuses: string[] = [];
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential() {
          credentialRequests += 1;
          return {
            relayUrl: 'wss://relay.test/ws',
            accessToken: 'user.initial.signature',
            expiresAtMs: 2_000_000,
          };
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

    expect(credentialRequests).toBe(0);
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
