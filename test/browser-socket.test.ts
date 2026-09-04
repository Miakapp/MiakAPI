import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBrowserClientWithRuntime } from '../src/browser-client.js';
import { BrowserSocketFactory } from '../src/internal/browser-socket.js';
import type { SocketHandlers } from '../src/internal/runtime.js';
import { FakeRuntime, flushMicrotasks } from './fakes/runtime.js';

type NativeListener = (event: never) => void;

class MockNativeWebSocket {
  static instances: MockNativeWebSocket[] = [];

  binaryType = 'blob';
  bufferedAmount = 0;
  protocol = 'miakapp';
  readyState = 0;
  closeCount = 0;
  readonly sent: Uint8Array[] = [];
  readonly #listeners = new Map<string, Set<NativeListener>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | readonly string[],
  ) {
    MockNativeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: NativeListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<NativeListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: NativeListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 2;
  }

  emit(type: string, event: unknown = {}): void {
    if (type === 'close') this.readyState = 3;
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event as never);
    }
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.#listeners.values()) count += listeners.size;
    return count;
  }
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

function handlers(overrides: Partial<SocketHandlers> = {}): SocketHandlers {
  return {
    message() {},
    close() {},
    error() {},
    ...overrides,
  };
}

describe('browser socket', () => {
  beforeEach(() => {
    MockNativeWebSocket.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockNativeWebSocket,
    });
  });

  afterEach(() => {
    if (originalWebSocket === undefined) {
      Reflect.deleteProperty(globalThis, 'WebSocket');
    } else {
      Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
    }
  });

  test('cleans up a transport that fails before opening', async () => {
    let transportErrors = 0;
    const connection = new BrowserSocketFactory().connect(
      'wss://relay.test/ws',
      handlers({ error() { transportErrors += 1; } }),
      new AbortController().signal,
    );
    const socket = MockNativeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket?.emit('error');

    await expect(connection).rejects.toThrow('WebSocket transport error');
    expect(transportErrors).toBe(1);
    expect(socket?.closeCount).toBe(1);
    expect(socket?.listenerCount()).toBe(0);
  });

  test('waits for a tracked pre-open transport to close before replacement', async () => {
    const runtime = new FakeRuntime(new BrowserSocketFactory(), 1_000_000);
    runtime.queueRandom(0);
    const client = createBrowserClientWithRuntime({
      homeId: 'test-home',
      credentialProvider: {
        async getCredential({ reason }) {
          return {
            relayUrl: 'wss://relay.test/ws',
            accessToken: `user.${reason}.signature`,
            expiresAtMs: 2_000_000,
          };
        },
      },
    }, runtime);
    const started = client.start();
    void started.catch(() => undefined);
    await flushMicrotasks();
    const first = MockNativeWebSocket.instances[0];
    if (first === undefined) throw new Error('Expected the first native WebSocket');

    first.emit('error');
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(first.readyState).toBe(2);
    expect(MockNativeWebSocket.instances).toHaveLength(1);

    first.emit('close', { code: 1006, reason: 'failed' });
    await flushMicrotasks();
    await runtime.advanceBy(0);
    expect(first.readyState).toBe(3);
    expect(MockNativeWebSocket.instances).toHaveLength(2);
    await client.stop();
  });

  test('stops after ten seconds when a tracked pre-open transport stays closing', async () => {
    const runtime = new FakeRuntime(new BrowserSocketFactory(), 1_000_000);
    const failures: string[] = [];
    const client = createBrowserClientWithRuntime({
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
    }, runtime);
    client.errors.subscribe(({ message }) => failures.push(message));
    const started = client.start();
    void started.catch(() => undefined);
    await flushMicrotasks();
    const socket = MockNativeWebSocket.instances[0];
    if (socket === undefined) throw new Error('Expected a native WebSocket');

    socket.emit('error');
    await flushMicrotasks();
    expect(client.status).toBe('reconnecting');
    expect(failures).toEqual(['Browser relay connection failed']);
    await runtime.advanceBy(9_999);
    expect(client.status).toBe('reconnecting');
    expect(MockNativeWebSocket.instances).toHaveLength(1);
    expect(socket.listenerCount()).toBe(4);

    await runtime.advanceBy(1);
    await expect(started).rejects.toThrow('Browser relay transport close timed out');
    expect(client.status).toBe('stopped');
    expect(MockNativeWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(2);
    expect(socket.listenerCount()).toBe(0);
    expect(failures).toEqual([
      'Browser relay connection failed',
      'Browser relay transport close timed out',
    ]);
  });

  test('terminates a relay that exceeds the rolling inbound byte budget', async () => {
    let now = 1_000;
    let messages = 0;
    const failures: string[] = [];
    const connection = new BrowserSocketFactory(() => now).connect(
      'wss://relay.test/ws',
      handlers({
        message() { messages += 1; },
        error(error) { failures.push(error.message); },
      }),
      new AbortController().signal,
    );
    const socket = MockNativeWebSocket.instances[0];
    expect(socket).toBeDefined();
    if (socket === undefined) throw new Error('Expected a native WebSocket');
    socket.readyState = 1;
    socket.emit('open');
    await connection;

    for (let index = 0; index < 4; index += 1) {
      socket.emit('message', { data: new ArrayBuffer(262_144) });
    }
    now += 1_000;
    for (let index = 0; index < 4; index += 1) {
      socket.emit('message', { data: new ArrayBuffer(262_144) });
    }
    socket.emit('message', { data: new ArrayBuffer(1) });

    expect(messages).toBe(8);
    expect(failures).toEqual(['Relay exceeded the browser inbound budget']);
    expect(socket.closeCount).toBe(1);
    expect(socket.readyState).toBe(2);

  });
});
