import type {
  BrowserCallHandle,
  BrowserCallOptions,
  BrowserCalls,
} from '../browser-api.js';
import type { ProtocolValue } from '../api.js';
import { LIMITS, Opcode, type Frame } from '../protocol/codec.js';
import {
  browserCancelled,
  browserOutcomeUnknown,
  browserProtocolFailure,
  browserRelayFailure,
  browserUnavailable,
  type BrowserClientError,
} from './browser-errors.js';
import { createDeferred, type Deferred } from './resources.js';
import type { BrowserRuntime, RuntimeTimer } from './runtime.js';
import type { UserRelaySession } from './user-session.js';
import { validateBrowserCallOptions, validateProtocolValue } from './validation.js';

export interface UserCallHost {
  readySession(): UserRelaySession | undefined;
  send(frame: Frame): Promise<void>;
  nextCallId(): number;
  nextLocalCallId(): number;
  runtime(): BrowserRuntime;
  emitFailure(failure: BrowserClientError): void;
  transportFailure(error: Error): void;
  functionDictionarySynchronized(): void;
}

interface PendingCall {
  readonly id: number;
  readonly localId: string;
  readonly session: UserRelaySession;
  readonly accepted: Deferred<void>;
  readonly result: Deferred<ProtocolValue>;
  readonly timer: RuntimeTimer;
  handedOff: boolean;
  wasAccepted: boolean;
  terminal: boolean;
  cancellationRequested: boolean;
  signal?: AbortSignal;
  abort?: () => void;
}

function integer(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw browserProtocolFailure(`${label} is invalid`);
  }
  return value;
}

function entries(value: ProtocolValue | undefined, label: string): ProtocolValue[] {
  if (!Array.isArray(value)) throw browserProtocolFailure(`${label} is not an array`);
  return value;
}

function sameEpoch(left: Uint8Array | undefined, right: ProtocolValue | undefined): right is Uint8Array {
  return left !== undefined
    && right instanceof Uint8Array
    && right.length === left.length
    && right.every((value, index) => value === left[index]);
}

export class UserCallManager implements BrowserCalls {
  readonly #host: UserCallHost;
  readonly #functionIds = new Map<string, number>();
  readonly #calls = new Map<number, PendingCall>();
  readonly #locallyCompleted = new Set<number>();
  readonly #rejectedIncoming = new Set<number>();
  #epoch: Uint8Array | undefined;
  #dictionarySeen = false;

  constructor(host: UserCallHost) {
    this.#host = host;
  }

  beginSession(epoch: Uint8Array): void {
    this.#epoch = epoch.slice();
    this.#functionIds.clear();
    this.#locallyCompleted.clear();
    this.#rejectedIncoming.clear();
    this.#dictionarySeen = false;
  }

  start(rawOptions: BrowserCallOptions): BrowserCallHandle {
    const options = validateBrowserCallOptions(rawOptions);
    const localId = `call:${this.#host.nextLocalCallId()}`;
    const accepted = createDeferred<void>();
    const result = createDeferred<ProtocolValue>();
    void accepted.promise.catch(() => undefined);
    void result.promise.catch(() => undefined);
    const inactive = (failure: BrowserClientError): BrowserCallHandle => {
      accepted.reject(failure);
      result.reject(failure);
      return Object.freeze({ localId, accepted: accepted.promise, result: result.promise, cancel() {} });
    };
    if (options.signal?.aborted === true) return inactive(browserCancelled('not_dispatched'));
    const session = this.#host.readySession();
    const functionId = this.#functionIds.get(options.function);
    if (session === undefined || functionId === undefined) {
      return inactive(browserUnavailable('Call target function is not available in a ready session'));
    }
    if (this.#calls.size >= session.welcome.limits.inflightCalls) {
      return inactive(browserUnavailable('Call concurrency limit is reached'));
    }
    const id = this.#host.nextCallId();
    const pending: PendingCall = {
      id,
      localId,
      session,
      accepted,
      result,
      handedOff: false,
      wasAccepted: false,
      terminal: false,
      cancellationRequested: false,
      timer: this.#host.runtime().setTimer(() => {
        this.#cancel(id, false, 'Call deadline expired');
      }, options.timeoutMs),
    };
    if (options.signal !== undefined) {
      const abort = () => this.#cancel(id, true, 'Call was aborted');
      pending.signal = options.signal;
      pending.abort = abort;
      options.signal.addEventListener('abort', abort, { once: true });
    }
    this.#calls.set(id, pending);
    const handle = Object.freeze({
      localId,
      accepted: accepted.promise,
      result: result.promise,
      cancel: () => this.#cancel(id, true, 'Call was cancelled'),
    });
    queueMicrotask(() => {
      if (pending.terminal) return;
      pending.handedOff = true;
      void session.send({
        opcode: Opcode.Call,
        payload: [
          id,
          0,
          null,
          functionId,
          options.timeoutMs,
          options.idempotencyKey ?? null,
          0,
          options.arguments,
        ],
      }).then(() => undefined, () => {
        if (this.#calls.get(id) === pending) {
          this.#fail(
            pending,
            browserOutcomeUnknown('Call transport handoff could not be confirmed'),
            true,
          );
        }
      });
    });
    return handle;
  }

  handleFrame(frame: Frame): boolean {
    if (frame.opcode === Opcode.FunctionDict) {
      this.#handleDictionary(frame);
      return true;
    }
    if (frame.opcode === Opcode.CallDispatch) {
      const id = integer(frame.payload[0], 'CALL_DISPATCH.callId');
      if (this.#rejectedIncoming.has(id)) {
        throw browserProtocolFailure('CALL_DISPATCH was duplicated');
      }
      this.#rememberRejectedIncoming(id);
      void this.#host.send({
        opcode: Opcode.CallError,
        payload: [id, 2000, false, 'Browser call handlers are not available', null],
      }).catch((error: unknown) => {
        this.#host.transportFailure(error instanceof Error ? error : browserUnavailable());
      });
      return true;
    }
    if (frame.opcode === Opcode.CallCancel || frame.opcode === Opcode.CallCredit) {
      const id = integer(frame.payload[0], 'callee callId');
      if (!this.#rejectedIncoming.has(id)) {
        throw browserProtocolFailure('Callee call frame is not correlated');
      }
      return true;
    }
    if (frame.opcode === Opcode.CallAccepted) {
      const id = integer(frame.payload[0], 'callId');
      if (this.#locallyCompleted.has(id)) return true;
      const call = this.#call(id);
      if (call.wasAccepted) throw browserProtocolFailure('CALL_ACCEPTED was duplicated');
      call.wasAccepted = true;
      call.accepted.resolve(undefined);
      return true;
    }
    if (frame.opcode === Opcode.CallResult) {
      const id = integer(frame.payload[0], 'callId');
      if (this.#locallyCompleted.delete(id)) return true;
      const call = this.#call(id);
      if (!call.wasAccepted) throw browserProtocolFailure('CALL_RESULT arrived before CALL_ACCEPTED');
      if (frame.payload[1] !== true) {
        throw browserProtocolFailure('Streaming CALL_RESULT exceeded zero browser credit');
      }
      call.result.resolve(validateProtocolValue(frame.payload[2], 'call result'));
      this.#finish(call);
      return true;
    }
    if (frame.opcode === Opcode.CallError) {
      const id = integer(frame.payload[0], 'callId');
      if (this.#locallyCompleted.delete(id)) return true;
      const call = this.#call(id);
      const code = integer(frame.payload[1], 'CALL_ERROR.code');
      const retryable = frame.payload[2];
      if (typeof retryable !== 'boolean') throw browserProtocolFailure('CALL_ERROR.retryable is invalid');
      const outcome = code === 1404 || (code === 1405 && call.wasAccepted)
        ? 'outcome_unknown'
        : call.wasAccepted ? 'accepted' : 'not_dispatched';
      const failure = browserRelayFailure(code, retryable, outcome, {
        kind: 'call', localId: call.localId,
      });
      this.#fail(call, failure);
      this.#host.emitFailure(failure);
      return true;
    }
    return false;
  }

  handleError(id: number, code: number, retryable: boolean): boolean {
    if (this.#locallyCompleted.delete(id)) return true;
    const call = this.#calls.get(id);
    if (call === undefined || call.terminal) return false;
    const outcome = code === 1404 || (code === 1405 && call.wasAccepted)
      ? 'outcome_unknown'
      : call.wasAccepted ? 'accepted' : 'not_dispatched';
    const failure = browserRelayFailure(code, retryable, outcome, {
      kind: 'call', localId: call.localId,
    });
    this.#fail(call, failure);
    this.#host.emitFailure(failure);
    return true;
  }

  handleResponseError(id: number, code: number, retryable: boolean): boolean {
    if (!this.#rejectedIncoming.delete(id)) return false;
    this.#host.transportFailure(browserRelayFailure(code, retryable, 'outcome_unknown'));
    return true;
  }

  disconnected(): void {
    for (const call of [...this.#calls.values()]) {
      this.#fail(call, call.handedOff ? browserOutcomeUnknown() : browserUnavailable());
    }
    this.#functionIds.clear();
    this.#locallyCompleted.clear();
    this.#rejectedIncoming.clear();
    this.#dictionarySeen = false;
    this.#epoch = undefined;
  }

  stop(): void {
    for (const call of [...this.#calls.values()]) {
      if (call.handedOff && !call.terminal) {
        void call.session.send({ opcode: Opcode.CallCancel, payload: [call.id, 1405] })
          .catch(() => undefined);
      }
      this.#fail(call, call.handedOff ? browserOutcomeUnknown() : browserCancelled('not_dispatched'));
    }
    this.#rejectedIncoming.clear();
  }

  #handleDictionary(frame: Frame): void {
    if (!sameEpoch(this.#epoch, frame.payload[0])) {
      throw browserProtocolFailure('FUNCTION_DICT uses a stale epoch');
    }
    const replace = frame.payload[1];
    if (typeof replace !== 'boolean') throw browserProtocolFailure('FUNCTION_DICT.replace is invalid');
    if (!replace && !this.#dictionarySeen) {
      throw browserProtocolFailure('FUNCTION_DICT addition arrived before a replacement');
    }
    const nextFunctionIds = replace ? new Map<string, number>() : new Map(this.#functionIds);
    const ids = new Set(nextFunctionIds.values());
    for (const raw of entries(frame.payload[2], 'FUNCTION_DICT.entries')) {
      const tuple = entries(raw, 'FUNCTION_DICT entry');
      const id = integer(tuple[0], 'FUNCTION_DICT.functionId');
      const name = tuple[1];
      if (typeof name !== 'string') throw browserProtocolFailure('FUNCTION_DICT.name is invalid');
      const existing = nextFunctionIds.get(name);
      if ((existing !== undefined && existing !== id) || (ids.has(id) && existing !== id)) {
        throw browserProtocolFailure('FUNCTION_DICT reassigns an identifier');
      }
      if (existing === undefined && nextFunctionIds.size >= LIMITS.statePathsPerHome) {
        throw browserProtocolFailure('FUNCTION_DICT exceeds the cumulative function limit');
      }
      nextFunctionIds.set(name, id);
      ids.add(id);
    }
    this.#functionIds.clear();
    for (const [name, id] of nextFunctionIds) this.#functionIds.set(name, id);
    if (replace) {
      this.#dictionarySeen = true;
      this.#host.functionDictionarySynchronized();
    }
  }

  #call(id: number): PendingCall {
    const call = this.#calls.get(id);
    if (call === undefined || call.terminal) throw browserProtocolFailure('Call frame is not correlated');
    return call;
  }

  #cancel(id: number, awaitTerminal: boolean, message: string): void {
    const call = this.#calls.get(id);
    if (call === undefined || call.terminal) return;
    if (!call.handedOff) {
      this.#fail(call, browserCancelled('not_dispatched', message));
      return;
    }
    if (call.cancellationRequested) {
      if (!awaitTerminal) this.#fail(call, browserOutcomeUnknown(message), true);
      return;
    }
    call.cancellationRequested = true;
    void call.session.send({ opcode: Opcode.CallCancel, payload: [id, 1405] }).then(
      () => { if (!awaitTerminal) this.#fail(call, browserOutcomeUnknown(message), true); },
      () => this.#fail(call, browserOutcomeUnknown(message), true),
    );
  }

  #fail(call: PendingCall, failure: BrowserClientError, remember = false): void {
    if (call.terminal) return;
    if (!call.accepted.settled) call.accepted.reject(failure);
    call.result.reject(failure);
    this.#finish(call);
    if (remember) this.#rememberLocallyCompleted(call.id);
  }

  #finish(call: PendingCall): void {
    call.terminal = true;
    call.timer.cancel();
    if (call.signal !== undefined && call.abort !== undefined) {
      call.signal.removeEventListener('abort', call.abort);
    }
    if (this.#calls.get(call.id) === call) this.#calls.delete(call.id);
  }

  #rememberLocallyCompleted(id: number): void {
    this.#locallyCompleted.delete(id);
    this.#locallyCompleted.add(id);
    if (this.#locallyCompleted.size <= LIMITS.inflightCalls) return;
    const oldest = this.#locallyCompleted.values().next().value;
    if (oldest !== undefined) this.#locallyCompleted.delete(oldest);
  }

  #rememberRejectedIncoming(id: number): void {
    this.#rejectedIncoming.delete(id);
    this.#rejectedIncoming.add(id);
    if (this.#rejectedIncoming.size <= LIMITS.inflightCalls) return;
    const oldest = this.#rejectedIncoming.values().next().value;
    if (oldest !== undefined) this.#rejectedIncoming.delete(oldest);
  }
}
