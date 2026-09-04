import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { LIMITS } from '../protocol/codec.js';
import type {
  CoordinatorRuntime,
  ManagedSocket,
  RuntimeTimer,
  SocketFactory,
  SocketHandlers,
} from './runtime.js';

const MAX_QUEUED_BYTES = 1_048_576;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const WEBSOCKET_SUBPROTOCOL = 'miakapp';

interface BoundedClientOptions extends ClientOptions {
  maxBufferedChunks: number;
  maxFragments: number;
}

function messageBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function websocketError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value !== null
    && typeof value === 'object'
    && 'error' in value
    && value.error instanceof Error) {
    return value.error;
  }
  return new Error('WebSocket transport error');
}

class WsManagedSocket implements ManagedSocket {
  readonly #socket: WebSocket;
  readonly #handlers: SocketHandlers;
  readonly #signal: AbortSignal;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((reason: unknown) => void) | undefined;
  #readySettled = false;
  #detached = false;

  constructor(socket: WebSocket, handlers: SocketHandlers, signal: AbortSignal) {
    this.#socket = socket;
    this.#handlers = handlers;
    this.#signal = signal;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    socket.on('open', this.#onOpen);
    socket.on('message', this.#onMessage);
    socket.on('close', this.#onClose);
    socket.on('error', this.#onError);
    signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  readonly #onOpen = (): void => {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#resolveReady?.();
  };

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    if (this.#detached) return;
    if (!isBinary) {
      this.#handlers.error(new Error('Relay sent a non-binary WebSocket message'));
      this.terminate();
      return;
    }
    this.#handlers.message(messageBytes(data));
  };

  readonly #onClose = (code: number, reason: Buffer): void => {
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady?.(new Error('WebSocket closed before authentication'));
    }
    if (!this.#detached) this.#handlers.close(code, reason.toString('utf8'));
  };

  readonly #onError = (value: unknown): void => {
    const error = websocketError(value);
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady?.(error);
    }
    if (!this.#detached) this.#handlers.error(error);
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
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not open'));
    }
    if (bytes.byteLength > LIMITS.frameBytes
      || this.#socket.bufferedAmount + bytes.byteLength > MAX_QUEUED_BYTES) {
      return Promise.reject(new RangeError('WebSocket outbound queue limit exceeded'));
    }
    try {
      this.#socket.send(bytes, { binary: true, compress: false }, (error) => {
        if (error instanceof Error && !this.#detached) this.#handlers.error(error);
      });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  close(code = 1000, reason = 'shutdown'): void {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(code, reason);
    else if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
  }

  terminate(): void {
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
  }

  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.#signal.removeEventListener('abort', this.#onAbort);
    this.#socket.off('open', this.#onOpen);
    this.#socket.off('message', this.#onMessage);
    this.#socket.off('close', this.#onClose);
  }
}

export class WsSocketFactory implements SocketFactory {
  async connect(
    url: string,
    handlers: SocketHandlers,
    signal: AbortSignal,
    onSocket?: (socket: ManagedSocket) => void,
  ): Promise<ManagedSocket> {
    if (signal.aborted) throw signal.reason;
    const options: BoundedClientOptions = {
      followRedirects: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxBufferedChunks: 4_096,
      maxFragments: 1_024,
      maxPayload: LIMITS.frameBytes,
      perMessageDeflate: false,
    };
    const managed = new WsManagedSocket(
      new WebSocket(url, WEBSOCKET_SUBPROTOCOL, options),
      handlers,
      signal,
    );
    onSocket?.(managed);
    try {
      await managed.ready();
      return managed;
    } catch (error) {
      managed.terminate();
      if (onSocket === undefined) managed.detach();
      throw error;
    }
  }
}

class NodeRuntimeTimer implements RuntimeTimer {
  readonly #timer: NodeJS.Timeout;

  constructor(callback: () => void, delayMs: number) {
    this.#timer = setTimeout(callback, delayMs);
  }

  cancel(): void {
    clearTimeout(this.#timer);
  }
}

export function createProductionRuntime(): CoordinatorRuntime {
  const socketFactory = new WsSocketFactory();
  return Object.freeze({
    socketFactory,
    now: () => Date.now(),
    random: () => Math.random(),
    setTimer: (callback: () => void, delayMs: number) => (
      new NodeRuntimeTimer(callback, delayMs)
    ),
  });
}
