import type { Unsubscribe } from '../api.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() { return settled; },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise?.(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      rejectPromise?.(reason);
    },
  };
}

export class ListenerSet<T> {
  readonly #listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  emit(value: T, onError?: (error: unknown) => void): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (error) {
        onError?.(error);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }

  get size(): number {
    return this.#listeners.size;
  }
}

export class IdSequence {
  #next = 1;

  take(): number {
    if (!Number.isSafeInteger(this.#next)) {
      throw new RangeError('Identifier namespace is exhausted');
    }
    const value = this.#next;
    this.#next += 1;
    return value;
  }
}

interface QueueWaiter<T> {
  resolve(value: IteratorResult<T>): void;
  reject(reason: unknown): void;
}

export class AsyncValueQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: Array<{ value: T }> = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  readonly #onConsume: (() => void) | undefined;
  #terminal: 'open' | 'closed' | 'failed' = 'open';
  #failure: unknown;

  constructor(onConsume?: () => void) {
    this.#onConsume = onConsume;
  }

  push(value: T): boolean {
    if (this.#terminal !== 'open') return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      this.#onConsume?.();
    } else {
      this.#values.push({ value });
    }
    return true;
  }

  close(): void {
    if (this.#terminal !== 'open') return;
    this.#terminal = 'closed';
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(reason: unknown): void {
    if (this.#terminal !== 'open') return;
    this.#terminal = 'failed';
    this.#failure = reason;
    this.#values.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
  }

  next(): Promise<IteratorResult<T>> {
    const entry = this.#values.shift();
    if (entry !== undefined) {
      this.#onConsume?.();
      return Promise.resolve({ done: false, value: entry.value });
    }
    if (this.#terminal === 'closed') {
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#terminal === 'failed') return Promise.reject(this.#failure);
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export function childAbortController(parent?: AbortSignal): {
  controller: AbortController;
  dispose: Unsubscribe;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted === true) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    dispose() { parent?.removeEventListener('abort', abort); },
  };
}
