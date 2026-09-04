import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BrowserSocketFactory } from '../src/internal/browser-socket.js';
import type { SocketHandlers } from '../src/internal/runtime.js';

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
    this.readyState = 3;
  }

  emit(type: string, event: unknown = {}): void {
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
    expect(socket.readyState).toBe(3);

  });
});
