import { describe, expect, test } from 'bun:test';
import {
  ApplicationCallError,
  type CoordinatorFailure,
  type CoordinatorLogRecord,
  type IncomingCall,
  type PresenceEntry,
  type ProtocolValue,
} from '../src/api.js';
import { Opcode } from '../src/protocol/codec.js';
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

const USER_PRINCIPAL: ProtocolValue[] = [
  1,
  'user-1',
  71,
  null,
  'user@example.test',
];

describe('outgoing calls', () => {
  test('streams under explicit credit and resolves one terminal result', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: { requested: true },
      timeoutMs: 5_000,
      idempotencyKey: 'intent-1',
      target: { kind: 'coordinator', id: 'target-coordinator' },
    });
    const call = await connection.nextClientFrame(Opcode.Call);
    const callId = integer(call.payload[0], 'CALL.callId');
    expect(call.payload.slice(1)).toEqual([
      2,
      'target-coordinator',
      301,
      5_000,
      'intent-1',
      1,
      { requested: true },
    ]);

    connection.send({ opcode: Opcode.CallAccepted, payload: [callId] });
    await handle.accepted;
    connection.send({ opcode: Opcode.CallResult, payload: [callId, false, 'progress-1'] });
    const stream = handle.stream[Symbol.asyncIterator]();
    expect(await stream.next()).toEqual({ done: false, value: 'progress-1' });
    const credit = await connection.nextClientFrame(Opcode.CallCredit);
    expect(credit.payload).toEqual([callId, 1]);

    connection.send({ opcode: Opcode.CallResult, payload: [callId, false, 'progress-2'] });
    expect(await stream.next()).toEqual({ done: false, value: 'progress-2' });
    await connection.nextClientFrame(Opcode.CallCredit);
    connection.send({ opcode: Opcode.CallResult, payload: [callId, true, { complete: true }] });
    expect(await handle.result).toEqual({ complete: true });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    await harness.coordinator.stop();
  });

  test('makes CALL_ERROR terminal and emits the same correlated failure', async () => {
    const harness = createTestHarness();
    const observed: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => observed.push(failure));
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 5_000,
    });
    const call = await connection.nextClientFrame(Opcode.Call);
    const callId = integer(call.payload[0], 'CALL.callId');
    connection.send({ opcode: Opcode.CallAccepted, payload: [callId] });
    await handle.accepted;
    connection.send({
      opcode: Opcode.CallError,
      payload: [callId, 2_001, false, 'Device refused', null],
    });
    const resultFailure = await handle.result.catch((error: unknown) => error);
    const streamFailure = await handle.stream[Symbol.asyncIterator]().next()
      .catch((error: unknown) => error);

    expect(isCoordinatorFailure(resultFailure) && resultFailure.outcome).toBe('accepted');
    expect(streamFailure).toBe(resultFailure);
    expect(observed[0]?.correlation).toEqual({ kind: 'call', localId: handle.localId });
    await harness.coordinator.stop();
  });

  test('can cancel synchronously before any CALL handoff', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 5_000,
    });
    handle.cancel('not needed');
    const acceptedFailure = await handle.accepted.catch((error: unknown) => error);
    const resultFailure = await handle.result.catch((error: unknown) => error);
    await flushMicrotasks();

    expect(isCoordinatorFailure(acceptedFailure) && acceptedFailure.outcome).toBe('not_dispatched');
    expect(resultFailure).toBe(acceptedFailure);
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('accepts an explicit pre-accept cancellation terminal as proof of non-dispatch', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 5_000,
    });
    const call = await connection.nextClientFrame(Opcode.Call);
    handle.cancel();
    const cancel = await connection.nextClientFrame(Opcode.CallCancel);
    expect(cancel.payload).toEqual([integer(call.payload[0], 'CALL.callId'), 1405]);
    connection.send({
      opcode: Opcode.CallError,
      payload: [integer(call.payload[0], 'CALL.callId'), 1405, false, 'Cancelled', null],
    });
    const acceptedFailure = await handle.accepted.catch((error: unknown) => error);
    const resultFailure = await handle.result.catch((error: unknown) => error);

    expect(isCoordinatorFailure(acceptedFailure) && acceptedFailure.outcome).toBe('not_dispatched');
    expect(resultFailure).toBe(acceptedFailure);
    await harness.coordinator.stop();
  });

  test('never retries a sent-before-accept call even when it carries an idempotency key', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: 'change-device',
      timeoutMs: 5_000,
      idempotencyKey: 'stable-intent',
    });
    const call = await connection.nextClientFrame(Opcode.Call);
    expect(call.payload[5]).toBe('stable-intent');
    connection.close();
    const acceptedFailure = await handle.accepted.catch((error: unknown) => error);
    const resultFailure = await handle.result.catch((error: unknown) => error);
    await flushMicrotasks();

    expect(isCoordinatorFailure(acceptedFailure) && acceptedFailure.outcome).toBe('outcome_unknown');
    expect(resultFailure).toBe(acceptedFailure);
    expect(harness.relay.connections).toHaveLength(1);
    await harness.coordinator.stop();
  });

  test('turns a local deadline into one cancel and an unknown outcome after handoff', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 250,
    });
    const call = await connection.nextClientFrame(Opcode.Call);
    await harness.runtime.advanceBy(250);
    const cancel = await connection.nextClientFrame(Opcode.CallCancel);
    expect(cancel.payload).toEqual([integer(call.payload[0], 'CALL.callId'), 1403]);
    const failure = await handle.result.catch((error: unknown) => error);
    void handle.accepted.catch(() => undefined);

    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');
    await harness.coordinator.stop();
  });

  test('settles at the deadline when an earlier cancellation receives no relay terminal', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 250,
    });
    await connection.nextClientFrame(Opcode.Call);
    handle.cancel();
    await connection.nextClientFrame(Opcode.CallCancel);
    await harness.runtime.advanceBy(250);
    const failure = await handle.result.catch((error: unknown) => error);
    void handle.accepted.catch(() => undefined);

    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('outcome_unknown');
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });

  test('routes a correlated CALL_CREDIT error to the active call', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const handle = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 5_000,
    });
    const call = await connection.nextClientFrame(Opcode.Call);
    const callId = integer(call.payload[0], 'CALL.callId');
    connection.send({ opcode: Opcode.CallAccepted, payload: [callId] });
    await handle.accepted;
    connection.send({ opcode: Opcode.CallResult, payload: [callId, false, 'progress'] });
    await handle.stream[Symbol.asyncIterator]().next();
    await connection.nextClientFrame(Opcode.CallCredit);
    connection.send({
      opcode: Opcode.Error,
      payload: [callId, Opcode.CallCredit, 1201, false, 'Credit rejected'],
    });
    const failure = await handle.result.catch((error: unknown) => error);

    expect(isCoordinatorFailure(failure) && failure.outcome).toBe('accepted');
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });
});

describe('incoming calls', () => {
  test('continues routing against the captured active handler during live synchronization', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness, configuration(() => 'active-handler'));
    const declaration = harness.coordinator.state.declare({ 'home.temperature': 26 });
    const state = await connection.nextClientFrame(Opcode.StateSync);
    expect(harness.coordinator.status).toBe('synchronizing');

    connection.send({
      opcode: Opcode.CallDispatch,
      payload: [90, USER_PRINCIPAL, 0, null, 301, 5_000, null, 0, null],
    });
    const result = await connection.nextClientFrame(Opcode.CallResult);
    expect(result.payload).toEqual([90, true, 'active-handler']);

    await connection.acknowledgeDeclarations(state);
    await declaration;
    await harness.coordinator.stop();
  });

  test('serializes progress under relay credit and captures an immutable principal', async () => {
    const observedCalls: IncomingCall[] = [];
    const handler = async (incoming: IncomingCall): Promise<ProtocolValue> => {
      observedCalls.push(incoming);
      await incoming.emit('progress-1');
      await incoming.emit('progress-2');
      return { echoed: incoming.arguments };
    };
    const harness = createTestHarness();
    const { connection } = await startReady(harness, configuration(handler));
    connection.send({
      opcode: Opcode.CallDispatch,
      payload: [91, USER_PRINCIPAL, 0, null, 301, 5_000, 'intent-91', 1, 'input'],
    });
    const first = await connection.nextClientFrame(Opcode.CallResult);
    expect(first.payload).toEqual([91, false, 'progress-1']);
    expect(observedCalls[0]?.source).toEqual({
      kind: 'user',
      id: 'user-1',
      sessionId: 71,
      coordinatorName: null,
      verifiedEmail: 'user@example.test',
    });
    expect(Object.isFrozen(observedCalls[0]?.source)).toBe(true);
    expect(observedCalls[0]?.idempotencyKey).toBe('intent-91');
    expect(connection.queuedClientFrameCount).toBe(0);

    connection.send({ opcode: Opcode.CallCredit, payload: [91, 1] });
    const second = await connection.nextClientFrame(Opcode.CallResult);
    const final = await connection.nextClientFrame(Opcode.CallResult);
    expect(second.payload).toEqual([91, false, 'progress-2']);
    expect(final.payload).toEqual([91, true, { echoed: 'input' }]);
    await harness.coordinator.stop();
  });

  test('preserves safe application errors and redacts unexpected handler failures', async () => {
    const appHarness = createTestHarness();
    const app = await startReady(appHarness, configuration(() => {
      throw new ApplicationCallError(2_042, 'Device is locked', true);
    }));
    app.connection.send({
      opcode: Opcode.CallDispatch,
      payload: [92, USER_PRINCIPAL, 0, null, 301, 5_000, null, 0, null],
    });
    const applicationError = await app.connection.nextClientFrame(Opcode.CallError);
    expect(applicationError.payload).toEqual([92, 2_042, true, 'Device is locked', null]);
    await appHarness.coordinator.stop();

    const logs: CoordinatorLogRecord[] = [];
    const genericHarness = createTestHarness({}, { write: (record) => logs.push(record) });
    const generic = await startReady(genericHarness, configuration(() => {
      throw new Error('secret credential value');
    }));
    generic.connection.send({
      opcode: Opcode.CallDispatch,
      payload: [93, USER_PRINCIPAL, 0, null, 301, 5_000, null, 0, null],
    });
    const genericError = await generic.connection.nextClientFrame(Opcode.CallError);
    expect(genericError.payload).toEqual([93, 1500, false, 'Application handler failed', null]);
    expect(JSON.stringify(logs)).not.toContain('secret credential value');
    expect(logs.some((record) => record.event === 'function_handler_failed')).toBe(true);
    await genericHarness.coordinator.stop();
  });

  test('turns an invalid fulfilled handler result into a generic CALL_ERROR', async () => {
    const declarations = configuration();
    Object.defineProperty(declarations.functions, 'home.echo', {
      configurable: true,
      enumerable: true,
      value: () => undefined,
      writable: true,
    });
    const harness = createTestHarness();
    const observed: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => observed.push(failure));
    const { connection } = await startReady(harness, declarations);
    connection.send({
      opcode: Opcode.CallDispatch,
      payload: [95, USER_PRINCIPAL, 0, null, 301, 5_000, null, 0, null],
    });
    const failure = await connection.nextClientFrame(Opcode.CallError);

    expect(failure.payload).toEqual([95, 1500, false, 'Application handler failed', null]);
    connection.send({
      opcode: Opcode.Error,
      payload: [95, Opcode.CallError, 1201, false, 'Reply rejected'],
    });
    await flushMicrotasks();
    expect(observed.some((entry) => entry.code === 1201 && entry.outcome === 'outcome_unknown'))
      .toBe(true);
    expect(harness.coordinator.status).toBe('ready');
    await harness.coordinator.stop();
  });

  test('aborts an active handler when the caller cancels', async () => {
    let observedSignal: AbortSignal | undefined;
    const handler = (incoming: IncomingCall): Promise<ProtocolValue> => {
      observedSignal = incoming.signal;
      return new Promise<ProtocolValue>((_resolve, reject) => {
        incoming.signal.addEventListener('abort', () => reject(incoming.signal.reason), { once: true });
      });
    };
    const harness = createTestHarness();
    const { connection } = await startReady(harness, configuration(handler));
    connection.send({
      opcode: Opcode.CallDispatch,
      payload: [94, USER_PRINCIPAL, 0, null, 301, 5_000, null, 0, null],
    });
    await flushMicrotasks();
    connection.send({ opcode: Opcode.CallCancel, payload: [94, 1405] });
    await flushMicrotasks();

    expect(observedSignal?.aborted).toBe(true);
    expect(connection.queuedClientFrameCount).toBe(0);
    await harness.coordinator.stop();
  });
});

describe('presence', () => {
  test('publishes immutable sorted snapshots and clears them on disconnect', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    const observed: Array<readonly PresenceEntry[]> = [];
    harness.coordinator.presence.subscribe((entries) => observed.push(entries));
    expect(observed).toEqual([[]]);

    connection.send({
      opcode: Opcode.PresenceSnapshot,
      payload: [[[72, 'user-2'], [71, 'user-1']]],
    });
    expect(harness.coordinator.presence.snapshot()).toEqual([
      { sessionId: 71, userId: 'user-1' },
      { sessionId: 72, userId: 'user-2' },
    ]);
    expect(Object.isFrozen(harness.coordinator.presence.snapshot())).toBe(true);
    connection.send({ opcode: Opcode.PresenceChange, payload: [71, 'user-1', 2] });
    expect(harness.coordinator.presence.snapshot()).toEqual([{ sessionId: 72, userId: 'user-2' }]);

    connection.close();
    await flushMicrotasks();
    expect(harness.coordinator.presence.snapshot()).toEqual([]);
    expect(observed.at(-1)).toEqual([]);
    await harness.coordinator.stop();
  });

  test('fails the session on conflicting presence changes', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startReady(harness);
    connection.send({ opcode: Opcode.PresenceChange, payload: [71, 'user-1', 1] });
    connection.send({ opcode: Opcode.PresenceChange, payload: [71, 'user-1', 1] });
    await flushMicrotasks();

    expect(failures.some((failure) => failure.kind === 'protocol')).toBe(true);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });
});
