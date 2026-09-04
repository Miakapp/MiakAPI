import { describe, expect, test } from 'bun:test';
import { EventDirection, type CoordinatorFailure } from '../src/api.js';
import { Opcode, type Frame, type ProtocolValue } from '../src/protocol/codec.js';
import type { FakeRelayConnection } from './fakes/relay.js';
import { flushMicrotasks } from './fakes/runtime.js';
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

function stringEntries(value: ProtocolValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is not an array`);
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
      throw new TypeError(`${label}[${index}] is invalid`);
    }
    return raw[0];
  });
}

function names(value: ProtocolValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is not an array`);
  return value.map((raw, index) => {
    if (typeof raw !== 'string') throw new TypeError(`${label}[${index}] is invalid`);
    return raw;
  });
}

function dictionary(values: readonly string[], firstId: number): ProtocolValue[] {
  return values.map((value, index) => [firstId + index, value]);
}

async function advanceThroughFunctionHandoff(
  connection: FakeRelayConnection,
  initialState?: Frame,
): Promise<Frame> {
  const state = initialState ?? await connection.nextClientFrame(Opcode.StateSync);
  connection.send({
    opcode: Opcode.StateSyncOk,
    payload: [
      integer(state.payload[0], 'STATE_SYNC.requestId'),
      connection.epoch,
      2,
      dictionary(stringEntries(state.payload[1], 'STATE_SYNC.entries'), 101),
    ],
  });
  const stateAccess = await connection.nextClientFrame(Opcode.StateAclSync);
  connection.send({
    opcode: Opcode.StateAclOk,
    payload: [integer(stateAccess.payload[0], 'STATE_ACL_SYNC.requestId'), 2],
  });
  const events = await connection.nextClientFrame(Opcode.EventSync);
  connection.send({
    opcode: Opcode.EventSyncOk,
    payload: [
      integer(events.payload[0], 'EVENT_SYNC.requestId'),
      dictionary(stringEntries(events.payload[1], 'EVENT_SYNC.entries'), 201),
    ],
  });
  const eventAccess = await connection.nextClientFrame(Opcode.EventAclSync);
  connection.send({
    opcode: Opcode.EventAclOk,
    payload: [integer(eventAccess.payload[0], 'EVENT_ACL_SYNC.requestId'), 2],
  });
  const functions = await connection.nextClientFrame(Opcode.FunctionSync);
  await flushMicrotasks();
  return functions;
}

function acknowledgeFunctions(connection: FakeRelayConnection, frame: Frame): void {
  connection.send({
    opcode: Opcode.FunctionSyncOk,
    payload: [
      integer(frame.payload[0], 'FUNCTION_SYNC.requestId'),
      dictionary(names(frame.payload[1], 'FUNCTION_SYNC.names'), 301),
    ],
  });
}

describe('declaration transactions', () => {
  test('defensively snapshots configuration before transport handoff', async () => {
    const harness = createTestHarness();
    const state = { 'home.temperature': 20 };
    const events = [{ topic: 'home.alert', directions: EventDirection.publishToUsers }];
    const configured = {
      state,
      stateAccess: [{ userId: 'user-1', patterns: ['home.*'] }],
      events,
      eventAccess: [],
      functions: { 'home.echo': () => 'original' },
    };
    harness.coordinator.configure(configured);
    state['home.temperature'] = 99;
    events[0]!.topic = 'home.mutated';

    const started = harness.coordinator.start();
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    const stateFrame = await connection.nextClientFrame(Opcode.StateSync);
    expect(stateFrame.payload[1]).toEqual([['home.temperature', 20]]);
    const exchange = await connection.acknowledgeDeclarations(stateFrame);
    expect(exchange.events.payload[1]).toEqual([
      ['home.alert', EventDirection.publishToUsers],
    ]);
    await started;
    await harness.coordinator.stop();
  });

  test('activates a live declaration atomically and resolves its receipt at the final ACK', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    let settled = false;
    const declaration = harness.coordinator.state.declare({
      'home.temperature': 21,
      'home.humidity': 45,
    }).finally(() => {
      settled = true;
    });
    const state = await connection.nextClientFrame(Opcode.StateSync);
    const functions = await advanceThroughFunctionHandoff(connection, state);
    expect(settled).toBe(false);
    expect(harness.coordinator.status).toBe('synchronizing');

    acknowledgeFunctions(connection, functions);
    expect(await declaration).toEqual({ sessionId: 41, generation: 4 });
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });

  test('supersedes a pre-handoff desired snapshot and ignores its stale ACK', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const first = harness.coordinator.state.declare({ 'home.temperature': 21 });
    const firstState = await connection.nextClientFrame(Opcode.StateSync);
    const second = harness.coordinator.state.declare({ 'home.temperature': 22 });
    const firstFailure = await first.catch((error: unknown) => error);
    const secondState = await connection.nextClientFrame(Opcode.StateSync);

    expect(isCoordinatorFailure(firstFailure) && firstFailure.kind).toBe('superseded');
    connection.send({
      opcode: Opcode.StateSyncOk,
      payload: [integer(firstState.payload[0], 'first request'), connection.epoch, 2, [[101, 'home.temperature']]],
    });
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('synchronizing');

    await connection.acknowledgeDeclarations(secondState);
    await expect(second).resolves.toEqual({ sessionId: 41, generation: 4 });
    await harness.coordinator.stop();
  });

  test('queues a newer desired snapshot after final-frame handoff', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const stateDeclaration = harness.coordinator.state.declare({ 'home.temperature': 23 });
    const functions = await advanceThroughFunctionHandoff(connection);

    const eventDeclaration = harness.coordinator.events.declare([
      { topic: 'home.alert', directions: EventDirection.publishToUsers },
      { topic: 'home.changed', directions: EventDirection.publishToUsers },
    ]);
    acknowledgeFunctions(connection, functions);
    await expect(stateDeclaration).resolves.toBeDefined();

    const queuedState = await connection.nextClientFrame(Opcode.StateSync);
    expect(queuedState.payload[1]).toEqual([['home.temperature', 23]]);
    await connection.acknowledgeDeclarations(queuedState);
    await expect(eventDeclaration).resolves.toBeDefined();
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });

  test('rolls a rejected desired slice back before the next transaction', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startReady(harness);
    const rejected = harness.coordinator.state.declare({ 'home.temperature': 99 });
    const state = await connection.nextClientFrame(Opcode.StateSync);
    connection.send({
      opcode: Opcode.StateSyncOk,
      payload: [integer(state.payload[0], 'STATE_SYNC.requestId'), connection.epoch, 2, [[101, 'home.temperature']]],
    });
    const stateAccess = await connection.nextClientFrame(Opcode.StateAclSync);
    connection.send({
      opcode: Opcode.Error,
      payload: [
        integer(stateAccess.payload[0], 'STATE_ACL_SYNC.requestId'),
        Opcode.StateAclSync,
        1301,
        false,
        'Synthetic collision',
      ],
    });
    const rejection = await rejected.catch((error: unknown) => error);
    expect(isCoordinatorFailure(rejection) && rejection.code).toBe(1301);
    expect(harness.coordinator.status).toBe('ready');

    const later = harness.coordinator.events.declare([
      { topic: 'home.alert', directions: EventDirection.publishToUsers },
      { topic: 'home.changed', directions: EventDirection.publishToUsers },
    ]);
    const rolledBackState = await connection.nextClientFrame(Opcode.StateSync);
    expect(rolledBackState.payload[1]).toEqual([['home.temperature', 20]]);
    await connection.acknowledgeDeclarations(rolledBackState);
    await later;
    expect(failures.some((failure) => failure.code === 1301)).toBe(true);
    await harness.coordinator.stop();
  });

  test('treats an out-of-order declaration acknowledgement as a protocol failure', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    const state = await connection.nextClientFrame(Opcode.StateSync);
    connection.send({
      opcode: Opcode.StateAclOk,
      payload: [integer(state.payload[0], 'STATE_SYNC.requestId'), 1],
    });
    await flushMicrotasks();

    expect(failures.some((failure) => failure.kind === 'protocol')).toBe(true);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });

  test('rejects an activation dictionary that does not match the declared snapshot', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    const state = await connection.nextClientFrame(Opcode.StateSync);
    connection.send({
      opcode: Opcode.StateSyncOk,
      payload: [integer(state.payload[0], 'STATE_SYNC.requestId'), connection.epoch, 1, []],
    });
    await flushMicrotasks();

    expect(failures.filter((failure) => failure.kind === 'protocol')).toHaveLength(1);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });
});
