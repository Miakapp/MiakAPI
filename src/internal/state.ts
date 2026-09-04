import type {
  CoordinatorState,
  DeclarationOptions,
  OperationOptions,
  ProtocolValue,
  StateMutation,
  StateReceipt,
} from '../api.js';
import { LIMITS, Opcode, type Frame } from '../protocol/codec.js';
import { cancelled, relayFailure, unavailable, outcomeUnknown } from './errors.js';
import type { CoordinatorError } from './errors.js';
import type { ActiveDeclarations, DeclarationManager } from './declarations.js';
import { createDeferred, type Deferred } from './resources.js';
import type { RelaySession } from './session.js';
import {
  validateDeclarationOptions,
  validateOperationOptions,
  validateStateEntries,
  validateStateMutations,
} from './validation.js';

export interface StateHost {
  readySession(): RelaySession | undefined;
  activeDeclarations(): ActiveDeclarations | undefined;
  nextRequestId(): number;
}

interface PendingStateSet {
  deferred: Deferred<StateReceipt>;
  epoch: Uint8Array;
  handedOff: boolean;
  abandoned: boolean;
  signal?: AbortSignal;
  abort?: () => void;
}

function requestId(frame: Frame): number | undefined {
  const value = frame.payload[0];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

export class StateManager implements CoordinatorState {
  readonly #host: StateHost;
  readonly #declarations: DeclarationManager;
  readonly #pending = new Map<number, PendingStateSet>();

  constructor(host: StateHost, declarations: DeclarationManager) {
    this.#host = host;
    this.#declarations = declarations;
  }

  declare(
    entries: Readonly<Record<string, ProtocolValue>>,
    options: DeclarationOptions = {},
  ): Promise<import('../api.js').DeclarationReceipt> {
    const signal = validateDeclarationOptions(options, 'state declaration');
    return this.#declarations.declareState(validateStateEntries(entries), signal);
  }

  set(mutations: readonly StateMutation[], options: OperationOptions = {}): Promise<StateReceipt> {
    const validated = validateStateMutations(mutations);
    const signal = validateOperationOptions(options, 'state operation');
    if (signal?.aborted === true) return Promise.reject(cancelled('not_dispatched'));
    const session = this.#host.readySession();
    const active = this.#host.activeDeclarations();
    if (session === undefined || active === undefined) return Promise.reject(unavailable());
    if (this.#pending.size >= LIMITS.declarationsPerCoordinator) {
      return Promise.reject(unavailable('State mutation concurrency limit is reached'));
    }

    const wireMutations = validated.map((mutation) => {
      const pathId = active.stateIds.get(mutation.path);
      if (pathId === undefined) throw new TypeError(`State path ${mutation.path} is not active`);
      return 'delete' in mutation
        ? [pathId, 1]
        : [pathId, 0, mutation.value];
    });
    const id = this.#host.nextRequestId();
    const deferred = createDeferred<StateReceipt>();
    const pending: PendingStateSet = {
      deferred,
      epoch: session.welcome.epoch.slice(),
      handedOff: false,
      abandoned: false,
    };
    if (signal !== undefined) {
      const abort = () => {
        if (!this.#pending.has(id)) return;
        if (pending.handedOff) {
          pending.abandoned = true;
          this.#removeAbort(pending);
          deferred.reject(outcomeUnknown());
        } else {
          this.#pending.delete(id);
          deferred.reject(cancelled('not_dispatched'));
        }
      };
      pending.signal = signal;
      pending.abort = abort;
      signal.addEventListener('abort', abort, { once: true });
    }
    this.#pending.set(id, pending);
    pending.handedOff = true;
    void session.send({
      opcode: Opcode.StateSet,
      payload: [id, session.welcome.epoch, wireMutations],
    }).then(() => undefined, () => {
      if (this.#pending.get(id) !== pending) return;
      this.#pending.delete(id);
      this.#removeAbort(pending);
      deferred.reject(unavailable('State mutation was not handed to the transport'));
    });
    return deferred.promise;
  }

  handleFrame(frame: Frame): boolean {
    if (frame.opcode !== Opcode.StateSetOk) return false;
    const id = requestId(frame);
    if (id === undefined) throw new TypeError('STATE_SET_OK has no request ID');
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new TypeError('STATE_SET_OK is not correlated');
    const epoch = frame.payload[1];
    if (!(epoch instanceof Uint8Array)
      || epoch.length !== pending.epoch.length
      || epoch.some((value, index) => value !== pending.epoch[index])) {
      throw new TypeError('STATE_SET_OK uses a stale epoch');
    }
    this.#pending.delete(id);
    this.#removeAbort(pending);
    if (!pending.abandoned) pending.deferred.resolve(Object.freeze({ outcome: 'applied' }));
    return true;
  }

  handleError(id: number, code: number, retryable: boolean): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) return false;
    this.#pending.delete(id);
    this.#removeAbort(pending);
    if (!pending.abandoned) {
      pending.deferred.reject(relayFailure(code, retryable, 'not_dispatched'));
    }
    return true;
  }

  disconnected(): void {
    for (const pending of this.#pending.values()) {
      this.#removeAbort(pending);
      pending.deferred.reject(pending.handedOff ? outcomeUnknown() : unavailable());
    }
    this.#pending.clear();
  }

  stop(failure: CoordinatorError): void {
    for (const pending of this.#pending.values()) {
      this.#removeAbort(pending);
      pending.deferred.reject(pending.handedOff ? outcomeUnknown() : failure);
    }
    this.#pending.clear();
  }

  #removeAbort(pending: PendingStateSet): void {
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
  }
}
