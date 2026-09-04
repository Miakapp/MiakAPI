import { LIMITS } from '../protocol/codec.js';
import type {
  BrowserRuntime,
  ManagedSocket,
  RuntimeTimer,
  SocketFactory,
  SocketHandlers,
} from './runtime.js';

const MAX_QUEUED_BYTES = 1_048_576;
const MAX_INBOUND_BYTES_PER_WINDOW = 1_048_576;
const MAX_INBOUND_FRAMES_PER_WINDOW = 256;
const INBOUND_WINDOW_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WEBSOCKET_SUBPROTOCOL = 'miakapp';
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

interface NativeMessageEvent {
  readonly data: unknown;
}

interface NativeCloseEvent {
  readonly code: number;
  readonly reason: string;
}

interface NativeWebSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly protocol: string;
  readonly readyState: number;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface NativeWebSocketConstructor {
  new(url: string, protocols?: string | readonly string[]): NativeWebSocket;
}

function nativeConstructor(): NativeWebSocketConstructor {
  const value = (globalThis as unknown as { WebSocket?: NativeWebSocketConstructor }).WebSocket;
  if (value === undefined) throw new Error('Native WebSocket is not available');
  return value;
}

class BrowserManagedSocket implements ManagedSocket {
  readonly #socket: NativeWebSocket;
  readonly #handlers: SocketHandlers;
  readonly #signal: AbortSignal;
  readonly #now: () => number;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((reason: unknown) => void) | undefined;
  #readySettled = false;
  #detached = false;
  #inboundWindowStartedMs: number | undefined;
  #inboundBytes = 0;
  #inboundFrames = 0;

  constructor(
    socket: NativeWebSocket,
    handlers: SocketHandlers,
    signal: AbortSignal,
    now: () => number,
  ) {
    this.#socket = socket;
    this.#handlers = handlers;
    this.#signal = signal;
    this.#now = now;
    socket.binaryType = 'arraybuffer';
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    socket.addEventListener('open', this.#onOpen);
    socket.addEventListener('message', this.#onMessage);
    socket.addEventListener('close', this.#onClose);
    socket.addEventListener('error', this.#onError);
    signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  readonly #onOpen = (): void => {
    if (this.#readySettled) return;
    this.#readySettled = true;
    if (this.#socket.protocol !== WEBSOCKET_SUBPROTOCOL) {
      this.#rejectReady?.(new Error('Relay did not negotiate the Miakapp WebSocket subprotocol'));
      this.terminate();
      return;
    }
    this.#resolveReady?.();
  };

  readonly #onMessage = (raw: never): void => {
    if (this.#detached) return;
    const event = raw as NativeMessageEvent;
    if (!(event.data instanceof ArrayBuffer)) {
      this.#handlers.error(new Error('Relay sent a non-binary WebSocket message'));
      this.terminate();
      return;
    }
    const bytes = event.data.byteLength;
    const now = this.#now();
    if (this.#inboundWindowStartedMs === undefined
      || now < this.#inboundWindowStartedMs
      || now - this.#inboundWindowStartedMs >= INBOUND_WINDOW_MS) {
      this.#inboundWindowStartedMs = now;
      this.#inboundBytes = 0;
      this.#inboundFrames = 0;
    }
    this.#inboundBytes += bytes;
    this.#inboundFrames += 1;
    if (bytes > LIMITS.frameBytes
      || this.#inboundBytes > MAX_INBOUND_BYTES_PER_WINDOW
      || this.#inboundFrames > MAX_INBOUND_FRAMES_PER_WINDOW) {
      this.#handlers.error(new Error('Relay exceeded the browser inbound budget'));
      this.terminate();
      return;
    }
    this.#handlers.message(new Uint8Array(event.data));
  };

  readonly #onClose = (raw: never): void => {
    const event = raw as NativeCloseEvent;
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady?.(new Error('WebSocket closed before authentication'));
    }
    if (!this.#detached) this.#handlers.close(event.code, event.reason);
  };

  readonly #onError = (): void => {
    const failure = new Error('WebSocket transport error');
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady?.(failure);
    }
    if (!this.#detached) this.#handlers.error(failure);
  };

  readonly #onAbort = (): void => {
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady?.(this.#signal.reason);
    }
    this.terminate();
  };

  ready(): Promise<void> {
    return this.#ready;
  }

  get bufferedBytes(): number {
    return this.#socket.bufferedAmount;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#socket.readyState !== OPEN) {
      return Promise.reject(new Error('WebSocket is not open'));
    }
    if (bytes.byteLength > LIMITS.frameBytes
      || this.#socket.bufferedAmount + bytes.byteLength > MAX_QUEUED_BYTES) {
      return Promise.reject(new RangeError('WebSocket outbound queue limit exceeded'));
    }
    try {
      this.#socket.send(bytes);
      return Promise.resolve();
    } catch {
      return Promise.reject(new Error('WebSocket send failed'));
    }
  }

  close(code = 1000, reason = 'shutdown'): void {
    if (this.#socket.readyState === OPEN || this.#socket.readyState === CONNECTING) {
      try {
        this.#socket.close(code, reason);
      } catch {
        try {
          this.#socket.close();
        } catch {
          // The browser owns final transport cleanup after both close attempts fail.
        }
      }
    }
  }

  terminate(): void {
    if (this.#socket.readyState !== CLOSED) this.close(1000, 'shutdown');
  }

  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.#signal.removeEventListener('abort', this.#onAbort);
    this.#socket.removeEventListener('open', this.#onOpen);
    this.#socket.removeEventListener('message', this.#onMessage);
    this.#socket.removeEventListener('close', this.#onClose);
    this.#socket.removeEventListener('error', this.#onError);
  }
}

export class BrowserSocketFactory implements SocketFactory {
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async connect(
    url: string,
    handlers: SocketHandlers,
    signal: AbortSignal,
    onSocket?: (socket: ManagedSocket) => void,
  ): Promise<ManagedSocket> {
    if (signal.aborted) throw signal.reason;
    const ManagedWebSocket = nativeConstructor();
    const socket = new BrowserManagedSocket(
      new ManagedWebSocket(url, WEBSOCKET_SUBPROTOCOL),
      handlers,
      signal,
      this.#now,
    );
    onSocket?.(socket);
    try {
      await socket.ready();
      return socket;
    } catch (error) {
      socket.terminate();
      if (onSocket === undefined) socket.detach();
      throw error;
    }
  }
}

class BrowserTimer implements RuntimeTimer {
  readonly #timer: ReturnType<typeof setTimeout>;

  constructor(callback: () => void, delayMs: number) {
    this.#timer = setTimeout(callback, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  }

  cancel(): void {
    clearTimeout(this.#timer);
  }
}

export function createBrowserRuntime(): BrowserRuntime {
  const now = () => Date.now();
  return Object.freeze({
    socketFactory: new BrowserSocketFactory(now),
    now,
    random: () => Math.random(),
    setTimer: (callback: () => void, delayMs: number) => new BrowserTimer(callback, delayMs),
  });
}
