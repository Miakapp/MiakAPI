/**
 * Call correlation for the guest side of the bridge.
 *
 * RFC 0001 semantics are preserved rather than smoothed over: `call.accepted`
 * is not success, cancellation is cooperative, and a call can end as
 * `outcome_unknown`. That last state is why a call rejects with a distinct
 * {@link CallOutcomeUnknownError} instead of a generic failure — a component
 * that retried it could act twice on the home.
 */
import {
  LIMITS,
  type CallChunk,
  type CallFailure,
  type CallOutcomeUnknown,
  type CallResult,
  type GuestMessageKind,
  type StructuredValue,
} from './protocol.js';

export class CallError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: StructuredValue | undefined;

  constructor(failure: CallFailure) {
    super(failure.message);
    this.name = 'MiakappCallError';
    this.code = failure.code;
    this.retryable = failure.retryable ?? false;
    this.details = failure.details;
  }
}

/** The call may or may not have been applied. Reconcile through state; never retry blindly. */
export class CallOutcomeUnknownError extends Error {
  readonly operationId: number;

  constructor(operationId: number, message?: string) {
    super(message ?? 'The call outcome is unknown');
    this.name = 'MiakappCallOutcomeUnknownError';
    this.operationId = operationId;
  }
}

export class CallCancelledError extends Error {
  constructor() {
    super('The call was cancelled');
    this.name = 'MiakappCallCancelledError';
  }
}

export interface CallOptions {
  readonly deadlineMs?: number;
  readonly signal?: { addEventListener(type: 'abort', listener: () => void): void };
}

export interface CallStream<T = StructuredValue> extends AsyncIterable<T> {
  readonly operationId: number;
  /** Terminal value, once the stream ends. */
  readonly result: Promise<StructuredValue>;
  cancel(): void;
}

type Send = (kind: GuestMessageKind, payload: unknown) => void;

interface Pending {
  accepted: boolean;
  credit: number;
  readonly chunks: StructuredValue[];
  readonly waiters: Array<(value: IteratorResult<StructuredValue>) => void>;
  readonly streaming: boolean;
  settled: boolean;
  resolve(value: StructuredValue): void;
  reject(error: Error): void;
}

export class CallManager {
  readonly #send: Send;
  readonly #pending = new Map<number, Pending>();
  #nextOperationId = 1;

  constructor(send: Send) {
    this.#send = send;
  }

  get outstanding(): number {
    return this.#pending.size;
  }

  call(name: string, args: StructuredValue, options: CallOptions = {}): Promise<StructuredValue> {
    return this.#start(name, args, options, false).promise;
  }

  stream(name: string, args: StructuredValue, options: CallOptions = {}): CallStream {
    const started = this.#start(name, args, options, true);
    const manager = this;
    const operationId = started.operationId;
    // Leaving a `for await` loop early cancels the call, which rejects the
    // terminal promise. Marking it handled here keeps that ordinary control
    // flow from surfacing as an unhandled rejection; `result` still rejects for
    // a caller that awaits it.
    void started.promise.catch(() => undefined);
    return {
      operationId,
      result: started.promise,
      cancel: () => manager.cancel(operationId),
      [Symbol.asyncIterator](): AsyncIterator<StructuredValue> {
        return {
          async next(): Promise<IteratorResult<StructuredValue>> {
            return await manager.#next(operationId);
          },
          async return(): Promise<IteratorResult<StructuredValue>> {
            manager.cancel(operationId);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  cancel(operationId: number): void {
    const pending = this.#pending.get(operationId);
    if (pending === undefined || pending.settled) return;
    this.#send('call.cancel', { operation_id: operationId });
    this.#settle(operationId, (entry) => entry.reject(new CallCancelledError()));
  }

  accept(operationId: number): void {
    const pending = this.#pending.get(operationId);
    if (pending === undefined) return;
    pending.accepted = true;
    if (pending.streaming) this.#grantCredit(operationId, pending);
  }

  chunk(message: CallChunk): void {
    const pending = this.#pending.get(message.operation_id);
    if (pending === undefined) return;
    pending.credit -= 1;
    const waiter = pending.waiters.shift();
    if (waiter === undefined) pending.chunks.push(message.value);
    else waiter({ done: false, value: message.value });
    this.#grantCredit(message.operation_id, pending);
  }

  result(message: CallResult): void {
    this.#settle(message.operation_id, (entry) => entry.resolve(message.value));
  }

  fail(message: CallFailure): void {
    this.#settle(message.operation_id, (entry) => entry.reject(new CallError(message)));
  }

  outcomeUnknown(message: CallOutcomeUnknown): void {
    this.#settle(message.operation_id, (entry) => entry.reject(
      new CallOutcomeUnknownError(message.operation_id, message.message),
    ));
  }

  /** Rejects everything in flight; used when the instance is disposed. */
  abortAll(error: Error): void {
    for (const operationId of [...this.#pending.keys()]) {
      this.#settle(operationId, (entry) => entry.reject(error));
    }
  }

  #start(
    name: string,
    args: StructuredValue,
    options: CallOptions,
    streaming: boolean,
  ): { promise: Promise<StructuredValue>; operationId: number } {
    if (this.#pending.size >= LIMITS.outstandingCalls) {
      throw new Error(`No more than ${LIMITS.outstandingCalls} calls may be in flight`);
    }
    if (options.deadlineMs !== undefined
      && (!Number.isSafeInteger(options.deadlineMs)
        || options.deadlineMs <= 0
        || options.deadlineMs > LIMITS.callDeadlineMs)) {
      throw new Error(`deadlineMs must be a positive integer of at most ${LIMITS.callDeadlineMs}`);
    }
    const operationId = this.#nextOperationId;
    this.#nextOperationId += 1;

    let resolve: (value: StructuredValue) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<StructuredValue>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.#pending.set(operationId, {
      accepted: false,
      credit: 0,
      chunks: [],
      waiters: [],
      streaming,
      settled: false,
      resolve,
      reject,
    });
    options.signal?.addEventListener('abort', () => this.cancel(operationId));
    this.#send('call.start', {
      operation_id: operationId,
      name,
      args,
      ...(options.deadlineMs === undefined ? {} : { deadline_ms: options.deadlineMs }),
    });
    return { promise, operationId };
  }

  async #next(operationId: number): Promise<IteratorResult<StructuredValue>> {
    const pending = this.#pending.get(operationId);
    if (pending === undefined) return { done: true, value: undefined };
    const buffered = pending.chunks.shift();
    if (buffered !== undefined) return { done: false, value: buffered };
    return await new Promise<IteratorResult<StructuredValue>>((resolve) => {
      pending.waiters.push(resolve);
    });
  }

  /** Keeps outstanding credit topped up to the ABI ceiling while a stream runs. */
  #grantCredit(operationId: number, pending: Pending): void {
    if (!pending.accepted || pending.settled) return;
    const missing = LIMITS.callCredit - pending.credit;
    if (missing <= 0) return;
    pending.credit += missing;
    this.#send('call.credit', { operation_id: operationId, credit: missing });
  }

  #settle(operationId: number, finish: (pending: Pending) => void): void {
    const pending = this.#pending.get(operationId);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    this.#pending.delete(operationId);
    for (const waiter of pending.waiters.splice(0)) waiter({ done: true, value: undefined });
    finish(pending);
  }
}
