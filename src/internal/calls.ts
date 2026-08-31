import type {
  CallHandle,
  CoordinatorCalls,
  CoordinatorFunctions,
  CoordinatorLogger,
  DeclarationOptions,
  FunctionHandler,
  IncomingCall,
  Principal,
  ProtocolValue,
  StartCallOptions,
} from '../api.js';
import { ApplicationCallError } from '../api.js';
import { LIMITS, Opcode, type Frame } from '../protocol/codec.js';
import type { ActiveDeclarations, DeclarationManager } from './declarations.js';
import {
  cancelled,
  outcomeUnknown,
  relayFailure,
  safeLog,
  unavailable,
  type CoordinatorError,
} from './errors.js';
import {
  AsyncValueQueue,
  createDeferred,
  type Deferred,
} from './resources.js';
import type { CoordinatorRuntime, RuntimeTimer } from './runtime.js';
import type { RelaySession } from './session.js';
import {
  targetFields,
  validateDeclarationOptions,
  validateFunctions,
  validateProtocolValue,
  validateStartCallOptions,
} from './validation.js';

export interface CallHost {
  readySession(): RelaySession | undefined;
  currentSession(): RelaySession | undefined;
  activeDeclarations(): ActiveDeclarations | undefined;
  nextCallId(): number;
  nextLocalCallId(): number;
  runtime(): CoordinatorRuntime;
  emitFailure(failure: CoordinatorError): void;
  logger(): CoordinatorLogger | undefined;
}

interface OutgoingCall {
  id: number;
  localId: string;
  session: RelaySession;
  accepted: Deferred<void>;
  result: Deferred<ProtocolValue>;
  stream: AsyncValueQueue<ProtocolValue>;
  handedOff: boolean;
  wasAccepted: boolean;
  terminal: boolean;
  cancellationRequested: boolean;
  credit: number;
  timer: RuntimeTimer;
  signal?: AbortSignal;
  abort?: () => void;
}

interface IncomingRoute {
  id: number;
  session: RelaySession;
  controller: AbortController;
  credit: number;
  creditWaiter: Deferred<void> | undefined;
  emitTail: Promise<void>;
  terminal: boolean;
  timer: RuntimeTimer;
}

function numeric(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is not an integer`);
  }
  return value;
}

function nullableString(value: ProtocolValue | undefined, label: string): string | null {
  if (value !== null && typeof value !== 'string') throw new TypeError(`${label} is invalid`);
  return value;
}

function principal(value: ProtocolValue | undefined): Principal {
  if (!Array.isArray(value)) throw new TypeError('CALL_DISPATCH source is invalid');
  const kind = value[0] === 1 ? 'user' : value[0] === 2 ? 'coordinator' : value[0] === 3 ? 'cli' : undefined;
  const id = value[1];
  const sessionId = value[2];
  const coordinatorName = value[3];
  const verifiedEmail = value[4];
  if (kind === undefined
    || typeof id !== 'string'
    || typeof sessionId !== 'number'
    || !Number.isSafeInteger(sessionId)
    || (coordinatorName !== null && typeof coordinatorName !== 'string')
    || (verifiedEmail !== null && typeof verifiedEmail !== 'string')) {
    throw new TypeError('CALL_DISPATCH source is invalid');
  }
  return Object.freeze({ kind, id, sessionId, coordinatorName, verifiedEmail });
}

function functionForId(active: ActiveDeclarations, id: number): {
  name: string;
  handler: FunctionHandler;
} | undefined {
  for (const [name, functionId] of active.functionIds) {
    if (functionId !== id) continue;
    const handler = active.snapshot.functions[name];
    if (handler !== undefined) return { name, handler };
  }
  return undefined;
}

export class FunctionManager implements CoordinatorFunctions {
  readonly #declarations: DeclarationManager;

  constructor(declarations: DeclarationManager) {
    this.#declarations = declarations;
  }

  declare(
    handlers: Readonly<Record<string, FunctionHandler>>,
    options: DeclarationOptions = {},
  ): Promise<import('../api.js').DeclarationReceipt> {
    return this.#declarations.declareFunctions(
      validateFunctions(handlers),
      validateDeclarationOptions(options, 'function declaration'),
    );
  }
}

export class CallManager implements CoordinatorCalls {
  readonly #host: CallHost;
  readonly #outgoing = new Map<number, OutgoingCall>();
  readonly #incoming = new Map<number, IncomingRoute>();
  readonly #completedIncoming = new Set<number>();
  readonly #functionIds = new Map<string, number>();
  #epoch: Uint8Array | undefined;

  constructor(host: CallHost) {
    this.#host = host;
  }

  start(rawOptions: StartCallOptions): CallHandle {
    const options = validateStartCallOptions(rawOptions);
    const localId = `call:${this.#host.nextLocalCallId()}`;
    const accepted = createDeferred<void>();
    const result = createDeferred<ProtocolValue>();
    void accepted.promise.catch(() => undefined);
    void result.promise.catch(() => undefined);
    const inactiveStream = new AsyncValueQueue<ProtocolValue>();
    const inactiveHandle = Object.freeze({
      localId,
      accepted: accepted.promise,
      stream: inactiveStream,
      result: result.promise,
      cancel() {},
    });
    if (options.signal?.aborted === true) {
      const failure = cancelled('not_dispatched');
      accepted.reject(failure);
      result.reject(failure);
      inactiveStream.fail(failure);
      return inactiveHandle;
    }
    const session = this.#host.readySession();
    const active = this.#host.activeDeclarations();
    const functionId = this.#functionIds.get(options.function)
      ?? active?.functionIds.get(options.function);
    if (session === undefined || active === undefined || functionId === undefined) {
      const failure = unavailable('Call target function is not available in a ready session');
      accepted.reject(failure);
      result.reject(failure);
      inactiveStream.fail(failure);
      return inactiveHandle;
    }
    if (this.#outgoing.size >= session.welcome.limits.inflightCalls) {
      const failure = unavailable('Call concurrency limit is reached');
      accepted.reject(failure);
      result.reject(failure);
      inactiveStream.fail(failure);
      return inactiveHandle;
    }

    const id = this.#host.nextCallId();
    const timer = this.#host.runtime().setTimer(() => {
      this.#cancelOutgoing(id, 1403, 'Call deadline expired', false);
    }, options.timeoutMs);
    const creditedStream = new AsyncValueQueue<ProtocolValue>(() => this.#grantCredit(id));
    const pending: OutgoingCall = {
      id,
      localId,
      session,
      accepted,
      result,
      stream: creditedStream,
      handedOff: false,
      wasAccepted: false,
      terminal: false,
      cancellationRequested: false,
      credit: 1,
      timer,
    };
    if (options.signal !== undefined) {
      const abort = () => this.#cancelOutgoing(id, 1405, 'Call was aborted', true);
      pending.signal = options.signal;
      pending.abort = abort;
      options.signal.addEventListener('abort', abort, { once: true });
    }
    this.#outgoing.set(id, pending);
    const returnedHandle = Object.freeze({
      localId,
      accepted: accepted.promise,
      stream: creditedStream,
      result: result.promise,
      cancel: (reason?: string) => {
        if (reason !== undefined && typeof reason !== 'string') {
          throw new TypeError('Call cancellation reason must be a string');
        }
        this.#cancelOutgoing(id, 1405, 'Call was cancelled', true);
      },
    });
    const [targetKind, targetValue] = targetFields(options.target);
    queueMicrotask(() => {
      if (pending.terminal) return;
      pending.handedOff = true;
      void session.send({
        opcode: Opcode.Call,
        payload: [
          id,
          targetKind,
          targetValue,
          functionId,
          options.timeoutMs,
          options.idempotencyKey ?? null,
          1,
          options.arguments,
        ],
      }).then(() => undefined, () => {
        if (this.#outgoing.get(id) !== pending) return;
        this.#terminalOutgoing(pending, unavailable('Call was not handed to the transport'));
      });
    });
    return returnedHandle;
  }

  setActiveDeclarations(active: ActiveDeclarations): void {
    this.#functionIds.clear();
    for (const [name, id] of active.functionIds) this.#functionIds.set(name, id);
    this.#epoch = this.#host.currentSession()?.welcome.epoch.slice();
  }

  handleFrame(frame: Frame): boolean {
    if (frame.opcode === Opcode.FunctionDict) {
      this.#handleFunctionDictionary(frame);
      return true;
    }
    if (frame.opcode === Opcode.CallDispatch) {
      this.#startIncoming(frame);
      return true;
    }
    if (frame.opcode === Opcode.CallAccepted) {
      const call = this.#outgoingCall(frame);
      if (call.wasAccepted) throw new TypeError('CALL_ACCEPTED was duplicated');
      call.wasAccepted = true;
      call.accepted.resolve();
      return true;
    }
    if (frame.opcode === Opcode.CallResult) {
      const call = this.#outgoingCall(frame);
      if (!call.wasAccepted) throw new TypeError('CALL_RESULT arrived before CALL_ACCEPTED');
      const final = frame.payload[1];
      const value = validateProtocolValue(frame.payload[2], 'call result');
      if (final === true) {
        call.result.resolve(value);
        call.stream.close();
        this.#finishOutgoing(call);
      } else if (final === false) {
        if (call.credit < 1) throw new TypeError('CALL_RESULT exceeded stream credit');
        call.credit -= 1;
        if (!call.stream.push(value)) throw new TypeError('CALL_RESULT followed a terminal frame');
      } else {
        throw new TypeError('CALL_RESULT final flag is invalid');
      }
      return true;
    }
    if (frame.opcode === Opcode.CallError) {
      const call = this.#outgoingCall(frame);
      const code = numeric(frame.payload[1], 'CALL_ERROR.code');
      const retryable = frame.payload[2];
      if (typeof retryable !== 'boolean') throw new TypeError('CALL_ERROR.retryable is invalid');
      const outcome = code === 1404 || (code === 1405 && call.wasAccepted)
        ? 'outcome_unknown'
        : call.wasAccepted
          ? 'accepted'
          : 'not_dispatched';
      const failure = relayFailure(code, retryable, outcome, {
        kind: 'call',
        localId: call.localId,
      });
      this.#terminalOutgoing(call, failure);
      this.#host.emitFailure(failure);
      return true;
    }
    if (frame.opcode === Opcode.CallCancel) {
      const id = numeric(frame.payload[0], 'CALL_CANCEL.callId');
      const incoming = this.#incoming.get(id);
      if (incoming === undefined) throw new TypeError('CALL_CANCEL is not correlated');
      this.#finishIncoming(incoming, cancelled('outcome_unknown'));
      return true;
    }
    if (frame.opcode === Opcode.CallCredit) {
      const id = numeric(frame.payload[0], 'CALL_CREDIT.callId');
      const additional = numeric(frame.payload[1], 'CALL_CREDIT.additionalCredit');
      const incoming = this.#incoming.get(id);
      if (incoming === undefined) throw new TypeError('CALL_CREDIT is not correlated');
      if (incoming.credit + additional > LIMITS.streamCredit) {
        throw new TypeError('CALL_CREDIT exceeds the credit limit');
      }
      incoming.credit += additional;
      incoming.creditWaiter?.resolve();
      incoming.creditWaiter = undefined;
      return true;
    }
    return false;
  }

  handleError(id: number, code: number, retryable: boolean): boolean {
    const call = this.#outgoing.get(id);
    if (call === undefined || call.terminal) return false;
    const outcome = code === 1404 || (code === 1405 && call.wasAccepted)
      ? 'outcome_unknown'
      : call.wasAccepted
        ? 'accepted'
        : 'not_dispatched';
    const failure = relayFailure(code, retryable, outcome, {
      kind: 'call',
      localId: call.localId,
    });
    this.#terminalOutgoing(call, failure);
    this.#host.emitFailure(failure);
    return true;
  }

  handleResponseError(id: number, code: number, retryable: boolean): boolean {
    const route = this.#incoming.get(id);
    if (route === undefined && !this.#completedIncoming.delete(id)) return false;
    const failure = relayFailure(code, retryable, 'outcome_unknown');
    if (route !== undefined) {
      this.#completedIncoming.delete(id);
      if (route.terminal) {
        route.controller.abort(failure);
        this.#removeIncoming(route);
      } else {
        this.#finishIncoming(route, failure);
      }
    }
    this.#host.emitFailure(failure);
    return true;
  }

  disconnected(): void {
    for (const call of [...this.#outgoing.values()]) {
      this.#terminalOutgoing(call, call.handedOff ? outcomeUnknown() : unavailable());
    }
    for (const route of [...this.#incoming.values()]) {
      this.#finishIncoming(route, outcomeUnknown());
    }
    this.#functionIds.clear();
    this.#completedIncoming.clear();
    this.#epoch = undefined;
  }

  stop(): void {
    for (const call of [...this.#outgoing.values()]) {
      if (call.handedOff && !call.terminal) {
        void call.session.send({ opcode: Opcode.CallCancel, payload: [call.id, 1405] });
      }
      this.#terminalOutgoing(call, call.handedOff ? outcomeUnknown() : cancelled('not_dispatched'));
    }
    for (const route of [...this.#incoming.values()]) {
      this.#finishIncoming(route, cancelled('outcome_unknown'));
    }
    this.#completedIncoming.clear();
  }

  #outgoingCall(frame: Frame): OutgoingCall {
    const id = numeric(frame.payload[0], 'callId');
    const call = this.#outgoing.get(id);
    if (call === undefined || call.terminal) throw new TypeError('Call frame is not correlated');
    return call;
  }

  #handleFunctionDictionary(frame: Frame): void {
    const epoch = frame.payload[0];
    const replace = frame.payload[1];
    const entries = frame.payload[2];
    if (!(epoch instanceof Uint8Array)
      || (replace !== true && replace !== false)
      || !Array.isArray(entries)) {
      throw new TypeError('FUNCTION_DICT is invalid');
    }
    if (this.#epoch !== undefined
      && (epoch.length !== this.#epoch.length
        || epoch.some((value, index) => value !== this.#epoch?.[index]))) {
      throw new TypeError('FUNCTION_DICT uses a stale epoch');
    }
    if (replace) this.#functionIds.clear();
    for (const raw of entries) {
      if (!Array.isArray(raw) || typeof raw[0] !== 'number' || typeof raw[1] !== 'string') {
        throw new TypeError('FUNCTION_DICT entry is invalid');
      }
      this.#functionIds.set(raw[1], raw[0]);
    }
  }

  #startIncoming(frame: Frame): void {
    const id = numeric(frame.payload[0], 'CALL_DISPATCH.callId');
    if (this.#incoming.has(id)) throw new TypeError('CALL_DISPATCH was duplicated');
    this.#completedIncoming.delete(id);
    const active = this.#host.activeDeclarations();
    const session = this.#host.currentSession();
    if (active === undefined || session === undefined) {
      throw new TypeError('CALL_DISPATCH arrived without an active ready session');
    }
    if (this.#incoming.size >= session.welcome.limits.inflightCalls) {
      throw new TypeError('CALL_DISPATCH exceeds the negotiated concurrency limit');
    }
    const functionId = numeric(frame.payload[4], 'CALL_DISPATCH.functionId');
    const declared = functionForId(active, functionId);
    if (declared === undefined) throw new TypeError('CALL_DISPATCH has no active handler');
    const timeoutMs = numeric(frame.payload[5], 'CALL_DISPATCH.timeoutMs');
    const source = principal(frame.payload[1]);
    const idempotencyKey = nullableString(frame.payload[6], 'CALL_DISPATCH.idempotencyKey');
    const credit = numeric(frame.payload[7], 'CALL_DISPATCH.initialCredit');
    const arguments_ = validateProtocolValue(frame.payload[8], 'call arguments');
    const controller = new AbortController();
    let route: IncomingRoute | undefined;
    const timer = this.#host.runtime().setTimer(() => {
      if (route !== undefined) {
        this.#finishIncoming(route, cancelled('outcome_unknown', 'Incoming call deadline expired'));
      }
    }, timeoutMs);
    route = {
      id,
      session,
      controller,
      credit,
      creditWaiter: undefined,
      emitTail: Promise.resolve(),
      terminal: false,
      timer,
    };
    this.#incoming.set(id, route);
    const incoming: IncomingCall = Object.freeze({
      source,
      arguments: arguments_,
      idempotencyKey,
      signal: controller.signal,
      emit: (value: ProtocolValue) => (
        this.#emitIncoming(route, validateProtocolValue(value, 'call progress'))
      ),
    });
    void Promise.resolve()
      .then(() => declared.handler(incoming))
      .then((value) => validateProtocolValue(value, 'call result'))
      .then((value) => this.#completeIncoming(route, value))
      .catch((error: unknown) => this.#failIncoming(route, error))
      .catch(() => undefined);
  }

  #emitIncoming(route: IncomingRoute, value: ProtocolValue): Promise<void> {
    const emit = route.emitTail.then(async () => {
      while (route.credit === 0) {
        if (route.terminal) throw cancelled('outcome_unknown');
        route.creditWaiter ??= createDeferred<void>();
        await route.creditWaiter.promise;
      }
      if (route.terminal) throw cancelled('outcome_unknown');
      route.credit -= 1;
      await route.session.send({
        opcode: Opcode.CallResult,
        payload: [route.id, false, value],
      });
    });
    route.emitTail = emit.catch(() => undefined);
    return emit;
  }

  async #completeIncoming(route: IncomingRoute, value: ProtocolValue): Promise<void> {
    try {
      await route.emitTail;
      if (route.terminal) return;
      route.terminal = true;
      this.#rememberIncomingResponse(route.id);
      await route.session.send({
        opcode: Opcode.CallResult,
        payload: [route.id, true, value],
      });
      this.#removeIncoming(route);
    } catch {
      route.controller.abort(outcomeUnknown());
      this.#removeIncoming(route);
    }
  }

  async #failIncoming(route: IncomingRoute, thrown: unknown): Promise<void> {
    if (route.terminal) return;
    route.terminal = true;
    this.#rememberIncomingResponse(route.id);
    const application = thrown instanceof ApplicationCallError ? thrown : undefined;
    if (application === undefined) {
      safeLog(this.#host.logger(), { level: 'error', event: 'function_handler_failed' });
    }
    try {
      await route.session.send({
        opcode: Opcode.CallError,
        payload: application === undefined
          ? [route.id, 1500, false, 'Application handler failed', null]
          : [route.id, application.code, application.retryable, application.message, null],
      });
    } finally {
      this.#removeIncoming(route);
    }
  }

  #grantCredit(id: number): void {
    const call = this.#outgoing.get(id);
    if (call === undefined || call.terminal || !call.wasAccepted) return;
    call.credit += 1;
    void call.session.send({ opcode: Opcode.CallCredit, payload: [id, 1] }).then(
      () => undefined,
      () => this.#terminalOutgoing(call, outcomeUnknown()),
    );
  }

  #cancelOutgoing(
    id: number,
    reasonCode: number,
    message: string,
    awaitRelayTerminal: boolean,
  ): void {
    const call = this.#outgoing.get(id);
    if (call === undefined || call.terminal) return;
    if (call.cancellationRequested) {
      if (!awaitRelayTerminal) this.#terminalOutgoing(call, outcomeUnknown(message));
      return;
    }
    if (call.handedOff) {
      call.cancellationRequested = true;
      void call.session.send({ opcode: Opcode.CallCancel, payload: [id, reasonCode] }).then(
        () => {
          if (!awaitRelayTerminal) this.#terminalOutgoing(call, outcomeUnknown(message));
        },
        () => this.#terminalOutgoing(call, outcomeUnknown(message)),
      );
    } else {
      this.#terminalOutgoing(call, cancelled('not_dispatched', message));
    }
  }

  #terminalOutgoing(call: OutgoingCall, failure: CoordinatorError): void {
    if (call.terminal) return;
    call.terminal = true;
    if (!call.accepted.settled) call.accepted.reject(failure);
    call.result.reject(failure);
    call.stream.fail(failure);
    this.#finishOutgoing(call);
  }

  #finishOutgoing(call: OutgoingCall): void {
    call.terminal = true;
    call.timer.cancel();
    if (call.signal !== undefined && call.abort !== undefined) {
      call.signal.removeEventListener('abort', call.abort);
    }
    if (this.#outgoing.get(call.id) === call) this.#outgoing.delete(call.id);
  }

  #finishIncoming(route: IncomingRoute, failure: CoordinatorError): void {
    if (route.terminal) return;
    route.terminal = true;
    route.controller.abort(failure);
    route.creditWaiter?.reject(failure);
    this.#removeIncoming(route);
  }

  #removeIncoming(route: IncomingRoute): void {
    route.timer.cancel();
    if (this.#incoming.get(route.id) === route) this.#incoming.delete(route.id);
  }

  #rememberIncomingResponse(id: number): void {
    this.#completedIncoming.delete(id);
    this.#completedIncoming.add(id);
    if (this.#completedIncoming.size <= LIMITS.inflightCalls) return;
    const oldest = this.#completedIncoming.values().next().value;
    if (oldest !== undefined) this.#completedIncoming.delete(oldest);
  }
}
