import { describe, expect, test } from 'bun:test';
import { Opcode } from '../src/protocol/codec.js';
import { flushMicrotasks } from './fakes/runtime.js';
import { createBrowserTestHarness, sendUserBootstrap, startBrowserReady } from './fakes/user-relay.js';

describe('browser state and calls', () => {
  test('isolates a throwing state listener from relay protocol health', async () => {
    const harness = createBrowserTestHarness();
    const failures: string[] = [];
    harness.client.errors.subscribe((failure) => failures.push(failure.kind));
    harness.client.state.subscribe(() => { throw new Error('application listener failed'); });
    await startBrowserReady(harness);
    expect(harness.client.status).toBe('ready');
    expect(failures).toEqual(['internal']);
    await harness.client.stop();
  });

  test('publishes defensive immutable snapshots and valid patches', async () => {
    const harness = createBrowserTestHarness();
    const { connection } = await startBrowserReady(harness, {
      state: { 'home.value': { nested: [1, 2], binary: new Uint8Array([3, 4]) } },
    });
    const first = harness.client.state.snapshot();
    expect(first?.revision).toBe(1);
    const firstValue = first?.values['home.value'];
    if (firstValue === null || Array.isArray(firstValue)
      || firstValue instanceof Uint8Array || typeof firstValue !== 'object') {
      throw new Error('Expected object state');
    }
    const binary = firstValue.binary;
    if (!(binary instanceof Uint8Array)) throw new Error('Expected binary state');
    binary[0] = 99;
    const again = harness.client.state.snapshot()?.values['home.value'];
    if (again === null || Array.isArray(again)
      || again instanceof Uint8Array || typeof again !== 'object'
      || !(again.binary instanceof Uint8Array)) throw new Error('Expected cloned state');
    expect([...again.binary]).toEqual([3, 4]);

    connection.send({
      opcode: Opcode.StatePatch,
      payload: [connection.epoch, 1, 2, [[101, 0, { nested: [5], binary: new Uint8Array([6]) }]]],
    });
    expect(harness.client.state.snapshot()?.revision).toBe(2);
    connection.send({
      opcode: Opcode.StatePatch,
      payload: [connection.epoch, 2, 3, [[101, 1]]],
    });
    expect(harness.client.state.snapshot()?.values['home.value']).toBeUndefined();
    await harness.client.stop();
  });

  test('delivers the authoritative snapshot immediately to a post-start subscriber', async () => {
    const harness = createBrowserTestHarness();
    await startBrowserReady(harness, { state: { 'home.temperature': 24 } });
    const observed: number[] = [];
    harness.client.state.subscribe((snapshot) => observed.push(
      snapshot.values['home.temperature'] as number,
    ));
    expect(observed).toEqual([24]);
    await harness.client.stop();
  });

  test('coalesces revision and dictionary mismatches into one resync', async () => {
    const harness = createBrowserTestHarness();
    const { connection } = await startBrowserReady(harness);
    connection.send({
      opcode: Opcode.StatePatch,
      payload: [connection.epoch, 99, 100, [[101, 0, 30]]],
    });
    connection.send({
      opcode: Opcode.StatePatch,
      payload: [connection.epoch, 100, 101, [[999, 0, 31]]],
    });
    const resync = await connection.nextClientFrame(Opcode.StateResync);
    expect(resync.payload).toEqual([1]);
    expect(connection.queuedClientFrameCount).toBe(0);
    expect(harness.client.state.snapshot()?.stale).toBe(true);
    connection.send({
      opcode: Opcode.StateDict,
      payload: [connection.epoch, true, [[101, 'home.temperature']]],
    });
    connection.send({
      opcode: Opcode.StateSnapshot,
      payload: [connection.epoch, 101, [[101, 31]]],
    });
    expect(harness.client.state.snapshot()).toMatchObject({ revision: 101, stale: false });
    expect(harness.client.state.snapshot()?.values['home.temperature']).toBe(31);
    await harness.client.stop();
  });

  test('reconnects when the relay rejects the only state resynchronization path', async () => {
    const harness = createBrowserTestHarness();
    harness.runtime.queueRandom(0);
    const { connection } = await startBrowserReady(harness);
    connection.send({
      opcode: Opcode.StatePatch,
      payload: [connection.epoch, 99, 100, [[101, 0, 30]]],
    });
    const resync = await connection.nextClientFrame(Opcode.StateResync);
    connection.send({
      opcode: Opcode.Error,
      payload: [resync.payload[0] ?? 0, Opcode.StateResync, 1500, true, 'Unavailable'],
    });
    await flushMicrotasks();
    expect(harness.client.status).toBe('reconnecting');
    await harness.runtime.advanceBy(0);
    const next = await harness.relay.connectionAt(1);
    await next.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(next, { revision: 100, state: { 'home.temperature': 30 } });
    await flushMicrotasks();
    expect(harness.client.status).toBe('ready');
    expect(harness.client.state.snapshot()).toMatchObject({ revision: 100, stale: false });
    await harness.client.stop();
  });

  test('rejects a snapshot that rolls back the active epoch', async () => {
    const harness = createBrowserTestHarness();
    const failures: Array<{ kind: string }> = [];
    harness.client.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startBrowserReady(harness, { revision: 5 });
    connection.send({
      opcode: Opcode.StateDict,
      payload: [connection.epoch, true, [[101, 'home.temperature']]],
    });
    connection.send({
      opcode: Opcode.StateSnapshot,
      payload: [connection.epoch, 4, [[101, 19]]],
    });
    await flushMicrotasks();
    expect(failures.some(({ kind }) => kind === 'protocol')).toBe(true);
    expect(harness.client.state.snapshot()).toMatchObject({ revision: 5, stale: true });
    await harness.client.stop();
  });

  test('routes one named call with distinct acceptance and result', async () => {
    const harness = createBrowserTestHarness();
    const { connection } = await startBrowserReady(harness);
    const call = harness.client.calls.start({
      function: 'home.echo',
      arguments: { target: 22 },
      timeoutMs: 5_000,
      idempotencyKey: 'intent-1',
    });
    await flushMicrotasks();
    const outbound = await connection.nextClientFrame(Opcode.Call);
    expect(outbound.payload).toEqual([1, 0, null, 301, 5_000, 'intent-1', 0, { target: 22 }]);
    connection.send({ opcode: Opcode.CallAccepted, payload: [1] });
    await call.accepted;
    connection.send({ opcode: Opcode.CallResult, payload: [1, true, { accepted: true }] });
    await expect(call.result).resolves.toEqual({ accepted: true });
    await harness.client.stop();
  });

  test('never replays a handed-off call after connection loss', async () => {
    const harness = createBrowserTestHarness();
    harness.runtime.queueRandom(0);
    const { connection } = await startBrowserReady(harness);
    const call = harness.client.calls.start({
      function: 'home.echo', arguments: null, timeoutMs: 5_000,
    });
    await connection.nextClientFrame(Opcode.Call);
    await flushMicrotasks();
    connection.close(1006, 'lost after handoff');
    const failure = await call.result.catch((error: unknown) => error);
    expect(failure).toMatchObject({ outcome: 'outcome_unknown' });
    await harness.runtime.advanceBy(0);
    const next = await harness.relay.connectionAt(1);
    await next.nextClientFrame(Opcode.Hello);
    sendUserBootstrap(next);
    await flushMicrotasks();
    expect(next.queuedClientFrameCount).toBe(0);
    await harness.client.stop();
  });

  test('cancels remotely when cancellation interleaves after synchronous handoff', async () => {
    const harness = createBrowserTestHarness();
    const { connection } = await startBrowserReady(harness);
    const call = harness.client.calls.start({
      function: 'home.echo', arguments: null, timeoutMs: 5_000,
    });
    await connection.nextClientFrame(Opcode.Call);
    call.cancel();
    const cancellation = await connection.nextClientFrame(Opcode.CallCancel);
    expect(cancellation.payload).toEqual([1, 1405]);
    connection.send({ opcode: Opcode.CallError, payload: [1, 1405, false, 'Cancelled', null] });
    await expect(call.result).rejects.toMatchObject({ outcome: 'not_dispatched' });
    await harness.client.stop();
  });

  test('rejects a valid inbound user-session call without dropping the connection', async () => {
    const harness = createBrowserTestHarness();
    const { connection } = await startBrowserReady(harness);
    connection.send({
      opcode: Opcode.CallDispatch,
      payload: [
        91,
        [2, 'integration', 8, 'test-coordinator', null],
        1,
        41,
        301,
        5_000,
        null,
        0,
        { target: 23 },
      ],
    });
    const rejection = await connection.nextClientFrame(Opcode.CallError);
    expect(rejection.payload).toEqual([
      91, 2000, false, 'Browser call handlers are not available', null,
    ]);
    connection.send({ opcode: Opcode.CallCancel, payload: [91, 1405] });
    await flushMicrotasks();
    expect(harness.client.status).toBe('ready');
    await harness.client.stop();
  });

  test('settles relay call errors exactly once', async () => {
    const harness = createBrowserTestHarness();
    const observed: string[] = [];
    harness.client.errors.subscribe((failure) => observed.push(failure.correlation?.localId ?? 'none'));
    const { connection } = await startBrowserReady(harness);
    const call = harness.client.calls.start({
      function: 'home.echo', arguments: null, timeoutMs: 5_000,
    });
    await connection.nextClientFrame(Opcode.Call);
    connection.send({ opcode: Opcode.CallError, payload: [1, 1200, false, 'Forbidden', null] });
    const failure = await call.result.catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'authorization', outcome: 'not_dispatched' });
    expect(observed).toEqual([call.localId]);
    await harness.client.stop();
  });

  test('ignores a correlated terminal frame after a local deadline settles the call', async () => {
    const harness = createBrowserTestHarness();
    const failures: Array<{ kind: string }> = [];
    harness.client.errors.subscribe((failure) => failures.push(failure));
    const { connection } = await startBrowserReady(harness);
    const call = harness.client.calls.start({
      function: 'home.echo', arguments: null, timeoutMs: 1,
    });
    await connection.nextClientFrame(Opcode.Call);
    await flushMicrotasks();
    await harness.runtime.advanceBy(1);
    await connection.nextClientFrame(Opcode.CallCancel);
    await flushMicrotasks();
    await expect(call.result).rejects.toMatchObject({ outcome: 'outcome_unknown' });
    connection.send({ opcode: Opcode.CallAccepted, payload: [1] });
    connection.send({ opcode: Opcode.CallError, payload: [1, 1405, false, 'Cancelled', null] });
    await flushMicrotasks();
    expect(failures).toEqual([]);
    expect(harness.client.status).toBe('ready');
    await harness.client.stop();
  });
});
