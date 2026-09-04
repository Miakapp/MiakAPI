import { describe, expect, test } from 'bun:test';
import type {
  AccessToken,
  CoordinatorFailure,
  CoordinatorLogRecord,
} from '../src/api.js';
import { createCoordinatorWithRuntime } from '../src/coordinator.js';
import {
  validateDeclarationOptions,
  validateEventPublishOptions,
  validateOperationOptions,
  validateProtocolValue,
  validateStartOptions,
  validateStopOptions,
} from '../src/internal/validation.js';
import { LIMITS, Opcode, type ProtocolValue } from '../src/protocol/codec.js';
import { FakeRelay } from './fakes/relay.js';
import { FakeRuntime, flushMicrotasks } from './fakes/runtime.js';
import {
  configuration,
  createTestHarness,
  isCoordinatorFailure,
  startReady,
} from './helpers.js';

function integer(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

describe('resource ownership', () => {
  test('bounds stop even when an access-token provider ignores cancellation', async () => {
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    let providerSignal: AbortSignal | undefined;
    const never = new Promise<AccessToken>(() => undefined);
    const coordinator = createCoordinatorWithRuntime({
      name: 'test-coordinator',
      accessTokenProvider: {
        getAccessToken(request) {
          providerSignal = request.signal;
          return never;
        },
      },
    }, runtime);
    const started = coordinator.start();
    void started.catch(() => undefined);
    await flushMicrotasks();
    expect(providerSignal?.aborted).toBe(false);

    let stopSettled = false;
    const stopped = coordinator.stop({ deadlineMs: 50 }).finally(() => {
      stopSettled = true;
    });
    expect(providerSignal?.aborted).toBe(true);
    await runtime.advanceBy(49);
    expect(stopSettled).toBe(false);
    await runtime.advanceBy(1);
    await stopped;
    expect(stopSettled).toBe(true);
    expect(coordinator.status).toBe('stopped');
    expect(relay.connections).toHaveLength(0);
  });

  test('uses deterministic full-jitter backoff without parallel sockets', async () => {
    const harness = createTestHarness();
    harness.relay.queueConnectError();
    harness.runtime.queueRandom(0.5);
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('reconnecting');

    await harness.runtime.advanceBy(499);
    expect(harness.relay.connections).toHaveLength(0);
    await harness.runtime.advanceBy(1);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    await connection.acknowledgeDeclarations();
    await started;

    expect(harness.tokenRequests.map((request) => request.reason)).toEqual(['initial', 'reconnect']);
    expect(harness.relay.socketHighWater).toBe(1);
    await harness.coordinator.stop();
  });

  test('coalesces scheduled reauthentication onto the active socket', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    await harness.runtime.advanceBy(969_999);
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.runtime.advanceBy(1);
    const reauth = await connection.nextClientFrame(Opcode.Reauth);
    expect(harness.tokenRequests.map((request) => request.reason)).toEqual(['initial', 'reauth']);
    connection.send({
      opcode: Opcode.ReauthOk,
      payload: [integer(reauth.payload[0], 'REAUTH.requestId'), harness.runtime.now() + 1_000_000],
    });
    await flushMicrotasks();

    expect(harness.relay.connections).toHaveLength(1);
    expect(harness.relay.socketHighWater).toBe(1);
    await harness.coordinator.stop();
  });

  test('does not let a stale reauthentication tear down a replacement session', async () => {
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    let releaseStale: ((token: AccessToken) => void) | undefined;
    const coordinator = createCoordinatorWithRuntime({
      name: 'test-coordinator',
      accessTokenProvider: {
        getAccessToken(request) {
          if (request.reason === 'reauth') {
            return new Promise<AccessToken>((resolve) => {
              releaseStale = resolve;
            });
          }
          return Promise.resolve({
            relayUrl: 'wss://relay.test/miakapp/ws',
            token: `token-${request.reason}`,
            expiresAtMs: runtime.now() + 1_000_000,
          });
        },
      },
    }, runtime);
    coordinator.configure(configuration());
    const started = coordinator.start();
    const first = await relay.connectionAt(0);
    await first.nextClientFrame(Opcode.Hello);
    await first.acknowledgeDeclarations();
    await started;

    await runtime.advanceBy(970_000);
    expect(releaseStale).toBeDefined();
    first.close();
    await flushMicrotasks();
    await runtime.advanceBy(0);
    const replacement = await relay.connectionAt(1);
    await replacement.nextClientFrame(Opcode.Hello);
    await replacement.acknowledgeDeclarations();
    expect(coordinator.status).toBe('ready');

    releaseStale?.({
      relayUrl: 'wss://relay.test/miakapp/ws',
      token: 'stale-reauth-token',
      expiresAtMs: runtime.now() + 1_000_000,
    });
    await flushMicrotasks(30);
    expect(coordinator.status).toBe('ready');
    expect(relay.openConnectionCount).toBe(1);
    expect(replacement.queuedClientFrameCount).toBe(0);
    await coordinator.stop();
  });

  test('caps frames buffered between WELCOME and SDK activation', async () => {
    const harness = createTestHarness({ autoWelcome: false });
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    connection.sendWelcome();
    for (let index = 0; index <= 256; index += 1) {
      connection.send({ opcode: Opcode.PresenceSnapshot, payload: [[]] });
    }
    await flushMicrotasks();

    expect(failures.some((failure) => failure.kind === 'protocol')).toBe(true);
    await harness.coordinator.stop();
  });

  test('caps aggregate bytes buffered between WELCOME and SDK activation', async () => {
    const harness = createTestHarness({ autoWelcome: false });
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    connection.sendWelcome();
    for (let index = 1; index <= 8; index += 1) {
      connection.send({
        opcode: Opcode.CallDispatch,
        payload: [
          index,
          [1, 'user-1', 71, null, null],
          0,
          null,
          301,
          5_000,
          null,
          0,
          new Uint8Array(131_072),
        ],
      });
    }
    await flushMicrotasks();

    expect(failures.filter((failure) => failure.kind === 'protocol')).toHaveLength(1);
    await harness.coordinator.stop();
  });

  test('reconstructs late event correlation without retaining every sent event', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startReady(harness);
    let firstLocalId = '';
    let firstWireId = 0;
    for (let index = 0; index < 1_100; index += 1) {
      const handle = harness.coordinator.events.publish('home.alert', index);
      const frame = await connection.nextClientFrame(Opcode.Event);
      if (index === 0) {
        firstLocalId = handle.localId;
        firstWireId = integer(frame.payload[0], 'EVENT.eventId');
      }
      await handle.sent;
    }
    connection.send({
      opcode: Opcode.Error,
      payload: [firstWireId, Opcode.Event, 1201, false, 'Delayed rejection'],
    });
    await flushMicrotasks();

    expect(failures.at(-1)?.correlation).toEqual({ kind: 'event', localId: firstLocalId });
    await harness.coordinator.stop();
  });
});

describe('dynamic-boundary validation and redaction', () => {
  test('rejects open option objects at every operation boundary', () => {
    expect(() => validateStartOptions({ signal: undefined, extra: true })).toThrow(/invalid shape/);
    expect(() => validateStopOptions({ deadlineMs: 1, extra: true })).toThrow(/invalid shape/);
    expect(() => validateDeclarationOptions({ extra: true }, 'declaration')).toThrow(/invalid shape/);
    expect(() => validateOperationOptions({ extra: true }, 'operation')).toThrow(/invalid shape/);
    expect(() => validateEventPublishOptions({ target: { kind: 'default' }, extra: true }))
      .toThrow(/invalid shape/);
  });

  test('rejects sparse, over-deep, symbolic, and reserved protocol structures', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => validateProtocolValue(sparse)).toThrow(/sparse/);

    let deep: unknown = null;
    for (let depth = 0; depth <= LIMITS.depth; depth += 1) deep = [deep];
    expect(() => validateProtocolValue(deep)).toThrow(/depth/);

    const symbolic: Record<string | symbol, unknown> = { safe: true };
    symbolic[Symbol('hidden')] = 'hidden';
    expect(() => validateProtocolValue(symbolic)).toThrow(/symbolic|non-enumerable/);
    expect(() => validateProtocolValue({ constructor: 'forbidden' })).toThrow(/reserved/);
  });

  test('never exposes access material through logs or public failures', async () => {
    const logs: CoordinatorLogRecord[] = [];
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    const coordinator = createCoordinatorWithRuntime({
      name: 'test-coordinator',
      logger: { write: (record) => logs.push(record) },
      accessTokenProvider: {
        async getAccessToken() {
          return {
            relayUrl: 'wss://relay.test/miakapp/ws',
            token: 'super-secret-access-token',
            expiresAtMs: runtime.now(),
          };
        },
      },
    }, runtime);
    let failure: unknown;
    coordinator.errors.subscribe((observed) => {
      failure = observed;
    });
    const started = coordinator.start();
    void started.catch(() => undefined);
    await flushMicrotasks();

    const serialized = JSON.stringify({ logs, failure });
    expect(serialized).not.toContain('super-secret-access-token');
    expect(isCoordinatorFailure(failure) && failure.kind).toBe('unavailable');
    await coordinator.stop({ deadlineMs: 0 });
    await runtime.advanceBy(0);
  });
});
