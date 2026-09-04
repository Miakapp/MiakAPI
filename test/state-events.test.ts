import { describe, expect, test } from 'bun:test';
import type {
  CoordinatorFailure,
  CoordinatorLogRecord,
  IncomingEvent,
} from '../src/api.js';
import { Opcode, type ProtocolValue } from '../src/protocol/codec.js';
import { flushMicrotasks } from './fakes/runtime.js';
import { createTestHarness, isCoordinatorFailure, startReady } from './helpers.js';

function integer(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

describe('state operations', () => {
  test('maps active paths, binds the session epoch, and settles only on STATE_SET_OK', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    let settled = false;
    const operation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 22 },
    ]).finally(() => {
      settled = true;
    });
    const frame = await connection.nextClientFrame(Opcode.StateSet);

    expect(frame.payload[1]).toEqual(connection.epoch);
    expect(frame.payload[2]).toEqual([[101, 0, 22]]);
    expect(settled).toBe(false);
    connection.send({
      opcode: Opcode.StateSetOk,
      payload: [integer(frame.payload[0], 'STATE_SET.requestId'), connection.epoch, 2],
    });
    await expect(operation).resolves.toEqual({ outcome: 'applied' });
    await harness.coordinator.stop();
  });

  test('uses an explicit relay rejection as proof that a mutation was not dispatched', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const operation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 23 },
    ]);
    const frame = await connection.nextClientFrame(Opcode.StateSet);
    connection.send({
      opcode: Opcode.Error,
      payload: [integer(frame.payload[0], 'STATE_SET.requestId'), Opcode.StateSet, 1201, false, 'Denied'],
    });
    const failure = await operation.catch((error: unknown) => error);

    expect(isCoordinatorFailure(failure) && failure.code).toBe(1201);
    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('not_dispatched');
    await harness.coordinator.stop();
  });

  test('uses outcome_unknown after a handed-off mutation loses its connection and never retries it', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const operation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 24 },
    ]);
    await connection.nextClientFrame(Opcode.StateSet);
    connection.close();
    const failure = await operation.catch((error: unknown) => error);
    await flushMicrotasks();

    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('keeps post-handoff cancellation correlation until the relay terminal arrives', async () => {
    const harness = createTestHarness();
    const observed: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => observed.push(failure));
    const { connection } = await startReady(harness);
    const controller = new AbortController();
    const operation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 24 },
    ], { signal: controller.signal });
    const frame = await connection.nextClientFrame(Opcode.StateSet);
    controller.abort();
    const failure = await operation.catch((error: unknown) => error);
    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');

    connection.send({
      opcode: Opcode.StateSetOk,
      payload: [integer(frame.payload[0], 'STATE_SET.requestId'), connection.epoch, 3],
    });
    await flushMicrotasks();
    expect(observed.some((entry) => entry.kind === 'protocol')).toBe(false);
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });

  test('ignores an old write callback after the request ID is reused on reconnect', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const staleWrite = connection.deferNextClientWrite();
    const staleOperation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 24 },
    ]);
    const staleFrame = await connection.nextClientFrame(Opcode.StateSet);
    connection.close();
    const staleFailure = await staleOperation.catch((error: unknown) => error);
    expect(isCoordinatorFailure(staleFailure) && staleFailure.outcome).toBe('outcome_unknown');

    await harness.runtime.advanceBy(0);
    const replacement = await harness.relay.connectionAt(1);
    await replacement.nextClientFrame(Opcode.Hello);
    await replacement.acknowledgeDeclarations();
    const replacementOperation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 25 },
    ]);
    const replacementFrame = await replacement.nextClientFrame(Opcode.StateSet);
    expect(integer(replacementFrame.payload[0], 'replacement request ID'))
      .toBe(integer(staleFrame.payload[0], 'stale request ID'));

    staleWrite.reject();
    await flushMicrotasks();
    replacement.send({
      opcode: Opcode.StateSetOk,
      payload: [
        integer(replacementFrame.payload[0], 'replacement request ID'),
        replacement.epoch,
        3,
      ],
    });
    await expect(replacementOperation).resolves.toEqual({ outcome: 'applied' });
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });

  test('rejects a stale-epoch acknowledgement as a protocol failure', async () => {
    const harness = createTestHarness();
    const observed: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => observed.push(failure));
    const { connection } = await startReady(harness);
    const operation = harness.coordinator.state.set([
      { path: 'home.temperature', value: 25 },
    ]);
    const frame = await connection.nextClientFrame(Opcode.StateSet);
    connection.send({
      opcode: Opcode.StateSetOk,
      payload: [integer(frame.payload[0], 'STATE_SET.requestId'), new Uint8Array(16).fill(99), 3],
    });
    const failure = await operation.catch((error: unknown) => error);
    await flushMicrotasks();

    expect(observed.some((entry) => entry.kind === 'protocol')).toBe(true);
    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');
    await harness.coordinator.stop();
  });
});

describe('events', () => {
  test('publishes at most once and orders sent before a correlated late error', async () => {
    const harness = createTestHarness();
    const observed: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => observed.push(failure));
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.events.publish('home.alert', { active: true }, {
      target: { kind: 'user_session', id: 71 },
    });
    const frame = await connection.nextClientFrame(Opcode.Event);
    expect(frame.payload.slice(1)).toEqual([201, 1, 71, { active: true }]);
    await expect(handle.sent).resolves.toEqual({ outcome: 'sent' });

    connection.send({
      opcode: Opcode.Error,
      payload: [integer(frame.payload[0], 'EVENT.eventId'), Opcode.Event, 1201, false, 'Denied'],
    });
    await flushMicrotasks();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.outcome).toBe('sent');
    expect(observed[0]?.correlation).toEqual({ kind: 'event', localId: handle.localId });
    await harness.coordinator.stop();
  });

  test('isolates local listeners and exposes immutable incoming source and value data', async () => {
    const logs: CoordinatorLogRecord[] = [];
    const harness = createTestHarness({}, { write: (record) => logs.push(record) });
    const { connection } = await startReady(harness);
    const received: IncomingEvent[] = [];
    const firstUnsubscribe = harness.coordinator.events.subscribe('home.alert', () => {
      throw new Error('listener failure');
    });
    harness.coordinator.events.subscribe('home.alert', (event) => received.push(event));
    connection.send({
      opcode: Opcode.Event,
      payload: [
        81,
        201,
        0,
        null,
        [1, 'user-1', 71, null, 'user@example.test'],
        { temperature: 22 },
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.source).toEqual({
      kind: 'user',
      id: 'user-1',
      sessionId: 71,
      coordinatorName: null,
      verifiedEmail: 'user@example.test',
    });
    expect(Object.isFrozen(received[0]?.source)).toBe(true);
    expect(Object.isFrozen(received[0]?.value)).toBe(true);
    expect(logs.some((record) => record.event === 'event_listener_failed')).toBe(true);
    firstUnsubscribe();
    firstUnsubscribe();
    await harness.coordinator.stop();
  });

  test('uses outcome_unknown when cancellation races after transport handoff', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const controller = new AbortController();
    const handle = harness.coordinator.events.publish('home.alert', true, {
      signal: controller.signal,
    });
    controller.abort();
    await connection.nextClientFrame(Opcode.Event);
    const failure = await handle.sent.catch((error: unknown) => error);

    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');
    await harness.coordinator.stop();
  });

  test('fails the session on an event with an unknown active topic ID', async () => {
    const harness = createTestHarness();
    const observed: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => observed.push(failure));
    const { connection } = await startReady(harness);
    connection.send({
      opcode: Opcode.Event,
      payload: [82, 999, 0, null, [1, 'user-1', 71, null, null], true],
    });
    await flushMicrotasks();

    expect(observed.some((failure) => failure.kind === 'protocol')).toBe(true);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });
});
