import { describe, expect, test } from 'bun:test';
import type { CoordinatorFailure, CoordinatorStatus } from '../src/api.js';
import { Opcode, type Frame, type ProtocolValue } from '../src/protocol/codec.js';
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

function requestId(frame: Frame): number {
  return integer(frame.payload[0], 'request ID');
}

describe('coordinator lifecycle', () => {
  test('resolves start only after the ordered five-domain synchronization barrier', async () => {
    const harness = createTestHarness();
    harness.coordinator.configure(configuration());
    const statuses: CoordinatorStatus[] = [];
    harness.coordinator.subscribe((event) => statuses.push(event.current));
    let startSettled = false;
    const started = harness.coordinator.start().finally(() => {
      startSettled = true;
    });
    const connection = await harness.relay.connectionAt(0);
    expect((await connection.nextClientFrame()).opcode).toBe(Opcode.Hello);

    const state = await connection.nextClientFrame(Opcode.StateSync);
    expect(startSettled).toBe(false);
    connection.send({
      opcode: Opcode.StateSyncOk,
      payload: [requestId(state), connection.epoch, 1, [[101, 'home.temperature']]],
    });
    const stateAccess = await connection.nextClientFrame(Opcode.StateAclSync);
    connection.send({ opcode: Opcode.StateAclOk, payload: [requestId(stateAccess), 1] });
    const events = await connection.nextClientFrame(Opcode.EventSync);
    connection.send({
      opcode: Opcode.EventSyncOk,
      payload: [requestId(events), [[201, 'home.alert']]],
    });
    const eventAccess = await connection.nextClientFrame(Opcode.EventAclSync);
    connection.send({ opcode: Opcode.EventAclOk, payload: [requestId(eventAccess), 1] });
    const functions = await connection.nextClientFrame(Opcode.FunctionSync);

    await flushMicrotasks();
    expect(startSettled).toBe(false);
    expect(harness.coordinator.status).toBe('synchronizing');

    connection.send({
      opcode: Opcode.FunctionSyncOk,
      payload: [requestId(functions), [[301, 'home.echo']]],
    });
    const ready = await started;
    expect(ready).toEqual({ sessionId: 41, generation: 4, connectedAtMs: 1_000_000 });
    expect(statuses).toEqual(['connecting', 'authenticating', 'synchronizing', 'ready']);
    await harness.coordinator.stop();
  });

  test('rejects duplicate starts and returns one shared terminal stop promise', async () => {
    const harness = createTestHarness();
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    const duplicateFailure = await harness.coordinator.start().catch((error: unknown) => error);
    expect(isCoordinatorFailure(duplicateFailure) && duplicateFailure.kind).toBe('invalid_lifecycle');

    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    await connection.acknowledgeDeclarations();
    await started;

    const firstStop = harness.coordinator.stop({ deadlineMs: 10 });
    const secondStop = harness.coordinator.stop({ deadlineMs: 99 });
    expect(firstStop).toBe(secondStop);
    await firstStop;
    expect(harness.coordinator.status).toBe('stopped');
    expect(harness.runtime.pendingTimerCount).toBe(0);
  });

  test('rejects start after an inert coordinator has already stopped', async () => {
    const harness = createTestHarness();
    await harness.coordinator.stop();
    const failure = await harness.coordinator.start().catch((error: unknown) => error);

    expect(isCoordinatorFailure(failure) && failure.kind).toBe('invalid_lifecycle');
    expect(harness.relay.connections).toHaveLength(0);
  });

  test('reconnects with full jitter, reacquires a token, and gates operations until ready', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    connection.close();
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('reconnecting');

    const offlineFailure = await harness.coordinator.state.set([
      { path: 'home.temperature', value: 22 },
    ]).catch((error: unknown) => error);
    expect(isCoordinatorFailure(offlineFailure) && offlineFailure.outcome).toBe('not_dispatched');

    await harness.runtime.advanceBy(0);
    const reconnected = await harness.relay.connectionAt(1);
    await reconnected.nextClientFrame(Opcode.Hello);
    const stateFrame = await reconnected.nextClientFrame(Opcode.StateSync);
    expect(harness.coordinator.status).toBe('synchronizing');
    expect(harness.tokenRequests.map((request) => request.reason)).toEqual(['initial', 'reconnect']);

    reconnected.send({
      opcode: Opcode.StateSyncOk,
      payload: [requestId(stateFrame), reconnected.epoch, 2, [[101, 'home.temperature']]],
    });
    const stateAccess = await reconnected.nextClientFrame(Opcode.StateAclSync);
    reconnected.send({ opcode: Opcode.StateAclOk, payload: [requestId(stateAccess), 2] });
    const events = await reconnected.nextClientFrame(Opcode.EventSync);
    reconnected.send({ opcode: Opcode.EventSyncOk, payload: [requestId(events), [[201, 'home.alert']]] });
    const eventAccess = await reconnected.nextClientFrame(Opcode.EventAclSync);
    reconnected.send({ opcode: Opcode.EventAclOk, payload: [requestId(eventAccess), 2] });
    const functions = await reconnected.nextClientFrame(Opcode.FunctionSync);
    reconnected.send({ opcode: Opcode.FunctionSyncOk, payload: [requestId(functions), [[301, 'home.echo']]] });
    await flushMicrotasks();

    expect(harness.coordinator.status).toBe('ready');
    expect(harness.relay.socketHighWater).toBe(1);
    await harness.coordinator.stop();
  });

  test('does not restore ready when a reconnect synchronization fails permanently', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startReady(harness);
    connection.close();
    await flushMicrotasks();
    await harness.runtime.advanceBy(0);

    const reconnected = await harness.relay.connectionAt(1);
    await reconnected.nextClientFrame(Opcode.Hello);
    const state = await reconnected.nextClientFrame(Opcode.StateSync);
    reconnected.send({
      opcode: Opcode.Error,
      payload: [requestId(state), Opcode.StateSync, 1301, false, 'Synthetic collision'],
    });
    await flushMicrotasks();

    expect(harness.coordinator.status).toBe('synchronizing');
    expect(failures.some((failure) => failure.code === 1301)).toBe(true);
    await harness.coordinator.stop();
  });

  test('an aborted start drives bounded shutdown and rejects before readiness', async () => {
    const harness = createTestHarness({ autoWelcome: false });
    harness.coordinator.configure(configuration());
    const controller = new AbortController();
    const started = harness.coordinator.start({ signal: controller.signal });
    await harness.relay.connectionAt(0);
    controller.abort('test abort');
    const failure = await started.catch((error: unknown) => error);
    await harness.coordinator.stop();

    expect(isCoordinatorFailure(failure) && failure.kind).toBe('cancelled');
    expect(harness.coordinator.status).toBe('stopped');
    expect(harness.runtime.pendingTimerCount).toBe(0);
  });

  test('stops reentrantly from a lifecycle listener without opening a socket', async () => {
    const harness = createTestHarness();
    harness.coordinator.configure(configuration());
    harness.coordinator.subscribe((event) => {
      if (event.current === 'connecting') void harness.coordinator.stop();
    });

    const failure = await harness.coordinator.start().catch((error: unknown) => error);
    await harness.coordinator.stop();
    expect(isCoordinatorFailure(failure) && failure.kind).toBe('cancelled');
    expect(harness.relay.connections).toHaveLength(0);
    expect(harness.coordinator.status).toBe('stopped');
  });

  test('rejects a WELCOME whose authentication expiry is not in the future', async () => {
    const harness = createTestHarness({ autoWelcome: false, expiresAtMs: 1_000_050 });
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    void started.catch(() => undefined);
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    await harness.runtime.advanceBy(100);
    connection.sendWelcome();
    await flushMicrotasks();

    expect(failures.some((failure) => failure.kind === 'protocol')).toBe(true);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });

  test('rejects a stale session epoch in STATE_SYNC_OK', async () => {
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
      payload: [requestId(state), new Uint8Array(16).fill(99), 1, [[101, 'home.temperature']]],
    });
    await flushMicrotasks();

    expect(failures.some((failure) => failure.kind === 'protocol')).toBe(true);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });

  test('rejects a REAUTH_OK whose expiry has already elapsed', async () => {
    const harness = createTestHarness();
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startReady(harness);
    await harness.runtime.advanceBy(970_000);
    const reauth = await connection.nextClientFrame(Opcode.Reauth);
    connection.send({
      opcode: Opcode.ReauthOk,
      payload: [requestId(reauth), 1_970_000],
    });
    await flushMicrotasks();

    expect(failures.some((failure) => failure.kind === 'protocol')).toBe(true);
    expect(harness.coordinator.status).toBe('reconnecting');
    await harness.coordinator.stop();
  });

  test('settles a non-retryable FATAL received before WELCOME', async () => {
    const harness = createTestHarness({ autoWelcome: false });
    const failures: CoordinatorFailure[] = [];
    harness.coordinator.errors.subscribe((failure) => failures.push(failure));
    harness.coordinator.configure(configuration());
    const started = harness.coordinator.start();
    const connection = await harness.relay.connectionAt(0);
    await connection.nextClientFrame(Opcode.Hello);
    connection.send({
      opcode: Opcode.Fatal,
      payload: [Opcode.Hello, 1100, false, 'Authentication rejected'],
    });
    const failure = await started.catch((error: unknown) => error);
    await harness.coordinator.stop();

    expect(isCoordinatorFailure(failure) && failure.code).toBe(1100);
    expect(failures.filter((entry) => entry.code === 1100)).toHaveLength(1);
    expect(harness.coordinator.status).toBe('stopped');
  });

  test('drains after GOAWAY and applies retryAfter only after relay close', async () => {
    const harness = createTestHarness();
    const { connection } = await startReady(harness);
    connection.send({ opcode: Opcode.Goaway, payload: [50, 0] });
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('draining');
    expect(harness.relay.openConnectionCount).toBe(1);

    const unavailableFailure = await harness.coordinator.state.set([
      { path: 'home.temperature', value: 22 },
    ]).catch((error: unknown) => error);
    expect(isCoordinatorFailure(unavailableFailure) && unavailableFailure.outcome)
      .toBe('not_dispatched');
    await harness.runtime.advanceBy(970_000);
    expect(connection.queuedClientFrameCount).toBe(0);
    connection.close();
    await flushMicrotasks();
    expect(harness.coordinator.status).toBe('reconnecting');

    await harness.runtime.advanceBy(49);
    expect(harness.relay.connections).toHaveLength(1);
    await harness.runtime.advanceBy(1);
    const reconnected = await harness.relay.connectionAt(1);
    expect((await reconnected.nextClientFrame()).opcode).toBe(Opcode.Hello);
    await harness.coordinator.stop();
  });
});
