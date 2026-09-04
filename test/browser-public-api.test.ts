import { describe, expect, test } from 'bun:test';
import * as browserEntrypoint from '../src/browser.js';
import { createBrowserClientWithRuntime } from '../src/browser-client.js';
import { FakeRelay } from './fakes/relay.js';
import { FakeRuntime, flushMicrotasks } from './fakes/runtime.js';
import { createBrowserTestHarness, startBrowserReady } from './fakes/user-relay.js';

describe('browser public API', () => {
  test('exports an isolated browser surface and constructs inertly', () => {
    expect(typeof browserEntrypoint.createBrowserClient).toBe('function');
    expect(typeof browserEntrypoint.createControlPlaneBrowserRelayCredentialProvider).toBe('function');
    expect('createCoordinator' in browserEntrypoint).toBe(false);
    expect('createHomeKeyAccessTokenProvider' in browserEntrypoint).toBe(false);

    const harness = createBrowserTestHarness();
    expect(harness.client.status).toBe('idle');
    expect(harness.client.state.snapshot()).toBeUndefined();
    expect(harness.relay.connections).toHaveLength(0);
    expect(harness.runtime.pendingTimerCount).toBe(0);
  });

  test('rejects invalid and open option shapes without creating resources', () => {
    const relay = new FakeRelay();
    const runtime = new FakeRuntime(relay);
    const valid = {
      homeId: 'test-home',
      credentialProvider: {
        async getCredential() {
          return {
            relayUrl: 'wss://relay.test/ws',
            accessToken: 'user.initial.signature',
            expiresAtMs: 2_000_000,
          };
        },
      },
    };
    expect(() => createBrowserClientWithRuntime({ ...valid, secret: 'forbidden' } as never, runtime))
      .toThrow(/invalid shape/);
    expect(() => createBrowserClientWithRuntime({ ...valid, homeId: '../bad' }, runtime))
      .toThrow(/homeId/);
    expect(() => createBrowserClientWithRuntime({ ...valid, credentialProvider: {} } as never, runtime))
      .toThrow(/getCredential/);
    expect(() => createBrowserClientWithRuntime({
      homeId: 'test-home',
      relayUrl: 'wss://relay.test/ws',
      idTokenProvider: { async getIdToken() { return 'firebase.header.signature'; } },
    } as never, runtime)).toThrow(/invalid shape/);
    expect(relay.connections).toHaveLength(0);
  });

  test('supports class providers and idempotent bounded cleanup', async () => {
    class Provider {
      async getCredential() {
        return {
          relayUrl: 'wss://relay.test/ws',
          accessToken: 'class.token.signature',
          expiresAtMs: 2_000_000,
        };
      }
    }
    const relay = new FakeRelay({ autoWelcome: false });
    const runtime = new FakeRuntime(relay);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: new Provider(),
    }, runtime);
    const first = client.stop({ deadlineMs: 0 });
    const second = client.stop({ deadlineMs: 1 });
    expect(second).toBe(first);
    await runtime.advanceBy(0);
    await first;
    expect(client.status).toBe('stopped');
  });

  test('removes lifecycle and state listeners idempotently', async () => {
    const harness = createBrowserTestHarness();
    let lifecycleEvents = 0;
    let stateEvents = 0;
    const removeLifecycle = harness.client.subscribe(() => { lifecycleEvents += 1; });
    const removeState = harness.client.state.subscribe(() => { stateEvents += 1; });
    removeLifecycle();
    removeLifecycle();
    removeState();
    removeState();
    await startBrowserReady(harness);
    await flushMicrotasks();
    expect(lifecycleEvents).toBe(0);
    expect(stateEvents).toBe(0);
    await harness.client.stop();
  });
});
