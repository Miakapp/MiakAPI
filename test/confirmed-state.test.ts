/**
 * Acknowledged state survives every complete re-declaration.
 *
 * RFC 0001 §7.5 makes every declaration change — an ACL, an event, a function,
 * a reconnect — resend all five slices, and `STATE_SYNC` carries a value for
 * every owned path. If the SDK resends the values it was configured with, every
 * ACL change silently rolls the home back to its initial state while users keep
 * seeing it as current. These tests pin the conservative rule instead: a
 * re-declaration carries the last value the relay *acknowledged*, never a
 * mutation whose outcome is unknown, and an explicit `state.declare` stays
 * authoritative.
 */
import { describe, expect, test } from 'bun:test';
import type { CoordinatorConfiguration } from '../src/api.js';
import { Opcode, type Frame, type ProtocolValue } from '../src/protocol/codec.js';
import type { FakeRelayConnection } from './fakes/relay.js';
import { flushMicrotasks } from './fakes/runtime.js';
import { configuration, createTestHarness, isCoordinatorFailure, startReady } from './helpers.js';

const TEMPERATURE = 'home.temperature';
const MODE = 'home.mode';

function twoPaths(): CoordinatorConfiguration {
  return { ...configuration(), state: { [TEMPERATURE]: 20, [MODE]: 'eco' } };
}

function requestIdOf(frame: Frame): number {
  const value = frame.payload[0];
  if (typeof value !== 'number') throw new TypeError('frame has no request ID');
  return value;
}

function syncedValues(frame: Frame): Record<string, ProtocolValue> {
  expect(frame.opcode).toBe(Opcode.StateSync);
  const values: Record<string, ProtocolValue> = {};
  for (const entry of frame.payload[1] as ProtocolValue[][]) values[entry[0] as string] = entry[1] as ProtocolValue;
  return values;
}

function acknowledge(connection: FakeRelayConnection, frame: Frame): void {
  connection.send({ opcode: Opcode.StateSetOk, payload: [requestIdOf(frame), connection.epoch, 9] });
}

function reject(connection: FakeRelayConnection, frame: Frame): void {
  connection.send({
    opcode: Opcode.Error,
    payload: [requestIdOf(frame), Opcode.StateSet, 1201, false, 'Denied'],
  });
}

const OWNER_ONLY = [{ userId: 'owner', patterns: ['home.*'] }];

describe('acknowledged state across re-declaration', () => {
  test('an ACL-only change resends the acknowledged value, not the configured one', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await expect(set).resolves.toEqual({ outcome: 'applied' });

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    await declared;

    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 22 });
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });

  test('event, event ACL and function re-declarations preserve it too', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 23 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set;

    const declarations = [
      () => harness.coordinator.events.declare([]),
      () => harness.coordinator.access.declareEvents([]),
      () => harness.coordinator.functions.declare({ 'home.echo': (call) => call.arguments }),
    ];
    for (const declare of declarations) {
      const pending = declare();
      const exchange = await connection.acknowledgeDeclarations();
      await pending;
      expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 23 });
    }
    await harness.coordinator.stop();
  });

  test('a reconnect, even to a new epoch, resends the acknowledged value without resending the mutation', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set;

    connection.close();
    await flushMicrotasks();
    await harness.runtime.advanceBy(60_000);
    const next = await harness.relay.connectionAt(1);
    await next.nextClientFrame(Opcode.Hello);
    expect(next.epoch).not.toEqual(connection.epoch);
    const exchange = await next.acknowledgeDeclarations();

    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 22 });
    expect(next.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('a rejected mutation is not preserved', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 99 }]);
    reject(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set.catch(() => undefined);

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    await declared;
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 20 });
    await harness.coordinator.stop();
  });

  test('a mutation lost with its connection is never replayed; the last acknowledged value is', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const confirmed = harness.coordinator.state.set([{ path: TEMPERATURE, value: 21 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await confirmed;
    const unknown = harness.coordinator.state.set([{ path: TEMPERATURE, value: 25 }]);
    await connection.nextClientFrame(Opcode.StateSet);
    connection.close();
    const failure = await unknown.catch((error: unknown) => error);
    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');

    await flushMicrotasks();
    await harness.runtime.advanceBy(60_000);
    const next = await harness.relay.connectionAt(1);
    await next.nextClientFrame(Opcode.Hello);
    const exchange = await next.acknowledgeDeclarations();
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 21 });
    expect(next.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('a mutation abandoned after handoff is preserved once its ACK proves it applied', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const controller = new AbortController();
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 26 }], { signal: controller.signal });
    const frame = await connection.nextClientFrame(Opcode.StateSet);
    controller.abort();
    const failure = await set.catch((error: unknown) => error);
    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');
    acknowledge(connection, frame);
    await flushMicrotasks();

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    await declared;
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 26 });
    await harness.coordinator.stop();
  });

  test('competing mutations keep the relay order of their acknowledgements', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness, twoPaths());
    const first = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }, { path: MODE, value: 'comfort' }]);
    const second = harness.coordinator.state.set([{ path: TEMPERATURE, value: 23 }]);
    const third = harness.coordinator.state.set([{ path: MODE, value: 'away' }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    reject(connection, await connection.nextClientFrame(Opcode.StateSet));
    await Promise.allSettled([first, second, third]);

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    await declared;
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 23, [MODE]: 'comfort' });
    await harness.coordinator.stop();
  });
});

describe('a mutation still pending when a re-declaration starts', () => {
  test('its ACK restarts the unhanded transaction, so the stale value is never activated', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    const setFrame = await connection.nextClientFrame(Opcode.StateSet);
    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const staleSync = await connection.nextClientFrame(Opcode.StateSync);
    expect(syncedValues(staleSync)).toEqual({ [TEMPERATURE]: 20 });

    // The relay processes frames in order: the mutation applies, then the
    // stale STATE_SYNC is staged. Its ACK therefore arrives first.
    acknowledge(connection, setFrame);
    await expect(set).resolves.toEqual({ outcome: 'applied' });
    const freshSync = await connection.nextClientFrame(Opcode.StateSync);
    expect(syncedValues(freshSync)).toEqual({ [TEMPERATURE]: 22 });

    // The stale stage's late acknowledgement is ignored; a new STATE_SYNC
    // already discarded it on the relay.
    connection.send({
      opcode: Opcode.StateSyncOk,
      payload: [requestIdOf(staleSync), connection.epoch, 1, [[101, TEMPERATURE]]],
    });
    await connection.acknowledgeDeclarations(freshSync);
    await declared;
    expect(harness.coordinator.status).toBe('ready');
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('a rejected pending mutation does not disturb the transaction', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    const setFrame = await connection.nextClientFrame(Opcode.StateSet);
    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const sync = await connection.nextClientFrame(Opcode.StateSync);
    reject(connection, setFrame);
    await set.catch(() => undefined);
    await connection.acknowledgeDeclarations(sync);
    await declared;
    expect(syncedValues(sync)).toEqual({ [TEMPERATURE]: 20 });
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('a revocation activates without waiting for a mutation ACK that never comes', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    await connection.nextClientFrame(Opcode.StateSet);
    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    await expect(declared).resolves.toBeDefined();
    expect(exchange.stateAccess.payload[1]).toEqual([['owner', ['home.*']]]);
    // Still unknown to the SDK, so the declaration carried the acknowledged value.
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 20 });
    void set.catch(() => undefined);
    await harness.coordinator.stop();
  });
});

describe('explicit state declarations stay authoritative', () => {
  test('state.declare replaces acknowledged values, and later re-declarations keep the declared ones', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set;

    const declaredState = harness.coordinator.state.declare({ [TEMPERATURE]: 30 });
    const first = await connection.acknowledgeDeclarations();
    await declaredState;
    expect(syncedValues(first.state)).toEqual({ [TEMPERATURE]: 30 });

    const declaredAccess = harness.coordinator.access.declareState(OWNER_ONLY);
    const second = await connection.acknowledgeDeclarations();
    await declaredAccess;
    expect(syncedValues(second.state)).toEqual({ [TEMPERATURE]: 30 });
    await harness.coordinator.stop();
  });

  test('a mutation sent before state.declare and acknowledged during it does not override the declaration', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    const setFrame = await connection.nextClientFrame(Opcode.StateSet);
    const declaredState = harness.coordinator.state.declare({ [TEMPERATURE]: 30 });
    const sync = await connection.nextClientFrame(Opcode.StateSync);
    acknowledge(connection, setFrame);
    await set;
    await connection.acknowledgeDeclarations(sync);
    await declaredState;
    expect(syncedValues(sync)).toEqual({ [TEMPERATURE]: 30 });

    const declaredAccess = harness.coordinator.access.declareState(OWNER_ONLY);
    const next = await connection.acknowledgeDeclarations();
    await declaredAccess;
    expect(syncedValues(next.state)).toEqual({ [TEMPERATURE]: 30 });
    await harness.coordinator.stop();
  });

  test('a path removed by state.declare is not resurrected', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness, twoPaths());
    const set = harness.coordinator.state.set([{ path: MODE, value: 'away' }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set;
    const declaredState = harness.coordinator.state.declare({ [TEMPERATURE]: 20 });
    await connection.acknowledgeDeclarations();
    await declaredState;
    const declaredAccess = harness.coordinator.access.declareState(OWNER_ONLY);
    const next = await connection.acknowledgeDeclarations();
    await declaredAccess;
    expect(syncedValues(next.state)).toEqual({ [TEMPERATURE]: 20 });
    await harness.coordinator.stop();
  });

  test('a rejected state.declare leaves acknowledged values in force', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set;

    const declaredState = harness.coordinator.state.declare({ [TEMPERATURE]: 30 });
    const sync = await connection.nextClientFrame(Opcode.StateSync);
    connection.send({
      opcode: Opcode.Error,
      payload: [requestIdOf(sync), Opcode.StateSync, 1201, false, 'Denied'],
    });
    await declaredState.catch(() => undefined);
    await flushMicrotasks();

    const declaredAccess = harness.coordinator.access.declareState(OWNER_ONLY);
    const next = await connection.acknowledgeDeclarations();
    await declaredAccess;
    expect(syncedValues(next.state)).toEqual({ [TEMPERATURE]: 22 });
    await harness.coordinator.stop();
  });
});

describe('acknowledged deletions', () => {
  test('are restored by one corrective delete right after activation, then no further frame', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const deleted = harness.coordinator.state.set([{ path: TEMPERATURE, delete: true }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await deleted;

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    // STATE_SYNC cannot declare a path without a value (RFC 0001 §7.2), so the
    // declared value is staged and the acknowledged deletion is reapplied.
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 20 });
    const corrective = await connection.nextClientFrame(Opcode.StateSet);
    expect(corrective.payload[1]).toEqual(connection.epoch);
    expect(corrective.payload[2]).toEqual([[101, 1]]);
    acknowledge(connection, corrective);
    await declared;
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('ready');
    expect(connection.queuedClientFrameCount).toBe(0);

    // A later value supersedes the deletion: nothing corrective follows.
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 19 }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await set;
    const again = harness.coordinator.access.declareState([]);
    const last = await connection.acknowledgeDeclarations();
    await again;
    await flushMicrotasks();
    expect(syncedValues(last.state)).toEqual({ [TEMPERATURE]: 19 });
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('an explicit state.declare cancels a pending restoration', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const deleted = harness.coordinator.state.set([{ path: TEMPERATURE, delete: true }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await deleted;
    const declaredState = harness.coordinator.state.declare({ [TEMPERATURE]: 18 });
    const exchange = await connection.acknowledgeDeclarations();
    await declaredState;
    await flushMicrotasks();
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 18 });
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('a refused restoration is reported and the relay value is taken as the acknowledged one', async () => {
    const harness = createTestHarness();
    const failures: unknown[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startReady(harness);
    const deleted = harness.coordinator.state.set([{ path: TEMPERATURE, delete: true }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await deleted;

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    await connection.acknowledgeDeclarations();
    reject(connection, await connection.nextClientFrame(Opcode.StateSet));
    await declared;
    await flushMicrotasks();
    expect(failures).toHaveLength(1);

    const again = harness.coordinator.access.declareState([]);
    await connection.acknowledgeDeclarations();
    await again;
    await flushMicrotasks();
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });
});

describe('defensive ordering', () => {
  test('an out-of-order ACK cannot regress a path to an older batch', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const older = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    const newer = harness.coordinator.state.set([{ path: TEMPERATURE, value: 23 }]);
    const olderFrame = await connection.nextClientFrame(Opcode.StateSet);
    const newerFrame = await connection.nextClientFrame(Opcode.StateSet);
    acknowledge(connection, newerFrame);
    acknowledge(connection, olderFrame);
    await Promise.all([older, newer]);

    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    const exchange = await connection.acknowledgeDeclarations();
    await declared;
    expect(syncedValues(exchange.state)).toEqual({ [TEMPERATURE]: 23 });
    await harness.coordinator.stop();
  });

  test('an ACK that arrives after the transaction was handed off triggers one bounded follow-up', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const set = harness.coordinator.state.set([{ path: TEMPERATURE, value: 22 }]);
    const setFrame = await connection.nextClientFrame(Opcode.StateSet);
    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    // A relay violating per-connection ordering: the ACK lands only after
    // FUNCTION_SYNC was handed off, when the stale stage can no longer be replaced.
    const sync = await connection.nextClientFrame(Opcode.StateSync);
    connection.send({
      opcode: Opcode.StateSyncOk,
      payload: [requestIdOf(sync), connection.epoch, 1, [[101, TEMPERATURE]]],
    });
    for (const [request, reply] of [
      [Opcode.StateAclSync, Opcode.StateAclOk],
      [Opcode.EventSync, Opcode.EventSyncOk],
      [Opcode.EventAclSync, Opcode.EventAclOk],
    ] as const) {
      const frame = await connection.nextClientFrame(request);
      connection.send({
        opcode: reply,
        payload: reply === Opcode.EventSyncOk
          ? [requestIdOf(frame), [[201, 'home.alert']]]
          : [requestIdOf(frame), 1],
      });
    }
    const functions = await connection.nextClientFrame(Opcode.FunctionSync);
    acknowledge(connection, setFrame);
    await set;
    connection.send({ opcode: Opcode.FunctionSyncOk, payload: [requestIdOf(functions), [[301, 'home.echo']]] });
    await declared;

    const followUp = await connection.acknowledgeDeclarations();
    expect(syncedValues(sync)).toEqual({ [TEMPERATURE]: 20 });
    expect(syncedValues(followUp.state)).toEqual({ [TEMPERATURE]: 22 });
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('ready');
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('a restoration lost with its connection is attempted again after the reconnect', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const deleted = harness.coordinator.state.set([{ path: TEMPERATURE, delete: true }]);
    acknowledge(connection, await connection.nextClientFrame(Opcode.StateSet));
    await deleted;
    const declared = harness.coordinator.access.declareState(OWNER_ONLY);
    await connection.acknowledgeDeclarations();
    await connection.nextClientFrame(Opcode.StateSet);
    await declared;
    connection.close();
    await flushMicrotasks();
    await harness.runtime.advanceBy(60_000);

    const next = await harness.relay.connectionAt(1);
    await next.nextClientFrame(Opcode.Hello);
    await next.acknowledgeDeclarations();
    const corrective = await next.nextClientFrame(Opcode.StateSet);
    expect(corrective.payload[1]).toEqual(next.epoch);
    expect(corrective.payload[2]).toEqual([[101, 1]]);
    await harness.coordinator.stop();
  });
});
