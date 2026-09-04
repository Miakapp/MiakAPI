import type { Frame } from '../protocol/codec.js';

export interface SocketHandlers {
  message(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  error(error: Error): void;
}

export interface ManagedSocket {
  readonly bufferedBytes: number;
  write(bytes: Uint8Array): Promise<void>;
  close(code?: number, reason?: string): void;
  terminate(): void;
  detach(): void;
}

export interface SocketFactory {
  connect(url: string, handlers: SocketHandlers, signal: AbortSignal): Promise<ManagedSocket>;
}

export interface RuntimeTimer {
  cancel(): void;
}

export interface CoordinatorRuntime {
  readonly socketFactory: SocketFactory;
  now(): number;
  random(): number;
  setTimer(callback: () => void, delayMs: number): RuntimeTimer;
}

export type BrowserRuntime = CoordinatorRuntime;

export interface SessionTransport {
  readonly generation: number;
  readonly epoch: Uint8Array;
  send(frame: Frame): Promise<void>;
}

export function delay(runtime: CoordinatorRuntime, delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = runtime.setTimer(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      timer.cancel();
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
