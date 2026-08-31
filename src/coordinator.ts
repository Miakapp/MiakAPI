import type {
  AccessToken,
  AccessTokenRequest,
  Coordinator,
  CoordinatorConfiguration,
  CoordinatorErrors,
  CoordinatorFailure,
  CoordinatorLogger,
  CoordinatorOptions,
  CoordinatorStatus,
  DeclarationReceipt,
  LifecycleEvent,
  ReadySession,
  StartOptions,
  StopOptions,
  Unsubscribe,
} from './api.js';
import { Opcode, type Frame } from './protocol/codec.js';
import {
  AccessManager,
  DeclarationManager,
  type ActiveDeclarations,
  type DeclarationHost,
} from './internal/declarations.js';
import {
  cancelled,
  CoordinatorError,
  internalFailure,
  invalidLifecycle,
  protocolFailure,
  relayFailure,
  safeLog,
  unavailable,
} from './internal/errors.js';
import { EventManager, type EventHost } from './internal/events.js';
import { CallManager, FunctionManager, type CallHost } from './internal/calls.js';
import { PresenceManager, type PresenceHost } from './internal/presence.js';
import {
  childAbortController,
  createDeferred,
  IdSequence,
  ListenerSet,
  type Deferred,
} from './internal/resources.js';
import { delay, type CoordinatorRuntime, type RuntimeTimer } from './internal/runtime.js';
import { RelaySession } from './internal/session.js';
import { createProductionRuntime } from './internal/socket.js';
import { StateManager, type StateHost } from './internal/state.js';
import {
  validateAccessToken,
  validateConfiguration,
  validateCoordinatorOptions,
  validateStartOptions,
  validateStopOptions,
} from './internal/validation.js';

interface SessionEnd {
  failure?: CoordinatorFailure;
  retryAfterMs?: number;
}

interface TokenRequest {
  controller: AbortController;
  dispose: Unsubscribe;
  promise: Promise<AccessToken>;
}

interface PendingReauthentication {
  requestId: number;
  deferred: Deferred<number>;
}

const FIRST_RECONNECT_CEILING_MS = 1_000;
const MAX_RECONNECT_CEILING_MS = 30_000;

function relayInteger(frame: Frame, index: number, label: string): number {
  const value = frame.payload[index];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw protocolFailure(`${label} is not an integer`);
  }
  return value;
}

function relayBoolean(frame: Frame, index: number, label: string): boolean {
  const value = frame.payload[index];
  if (typeof value !== 'boolean') throw protocolFailure(`${label} is not a boolean`);
  return value;
}

class CoordinatorImpl implements
  Coordinator,
  DeclarationHost,
  StateHost,
  EventHost,
  CallHost,
  PresenceHost {
  readonly #options: CoordinatorOptions;
  readonly #runtime: CoordinatorRuntime;
  readonly #lifecycleListeners = new ListenerSet<LifecycleEvent>();
  readonly #errorListeners = new ListenerSet<CoordinatorFailure>();
  readonly #declarations: DeclarationManager;
  readonly #loopController = new AbortController();
  readonly state: StateManager;
  readonly access: AccessManager;
  readonly events: EventManager;
  readonly functions: FunctionManager;
  readonly calls: CallManager;
  readonly presence: PresenceManager;
  readonly errors: CoordinatorErrors;
  #status: CoordinatorStatus = 'idle';
  #started = false;
  #configured = false;
  #session: RelaySession | undefined;
  #sessionEnd: Deferred<SessionEnd> | undefined;
  #startDeferred: Deferred<ReadySession> | undefined;
  #stopDeferred: Deferred<void> | undefined;
  #stopTimer: RuntimeTimer | undefined;
  #loopTask: Promise<void> | undefined;
  #startSignal: AbortSignal | undefined;
  #startAbort: (() => void) | undefined;
  #tokenRequest: TokenRequest | undefined;
  #reauthentication: PendingReauthentication | undefined;
  #reauthTimer: import('./internal/runtime.js').RuntimeTimer | undefined;
  #requestIds = new IdSequence();
  #eventIds = new IdSequence();
  #callIds = new IdSequence();
  readonly #localEventIds = new IdSequence();
  readonly #localCallIds = new IdSequence();
  #reconnectAttempt = 0;
  #relayHost: string | undefined;
  #goawayRetryAfterMs: number | undefined;

  constructor(options: CoordinatorOptions, runtime: CoordinatorRuntime) {
    this.#options = options;
    this.#runtime = runtime;
    this.#declarations = new DeclarationManager(this);
    this.state = new StateManager(this, this.#declarations);
    this.access = new AccessManager(this.#declarations);
    this.events = new EventManager(this, this.#declarations);
    this.functions = new FunctionManager(this.#declarations);
    this.calls = new CallManager(this);
    this.presence = new PresenceManager(this);
    this.errors = Object.freeze({
      subscribe: (listener: (failure: CoordinatorFailure) => void) => {
        if (typeof listener !== 'function') throw new TypeError('error listener must be a function');
        return this.#errorListeners.subscribe(listener);
      },
    });
  }

  get status(): CoordinatorStatus {
    return this.#status;
  }

  configure(configuration: CoordinatorConfiguration): void {
    if (this.#started || this.#status !== 'idle' || this.#configured) {
      throw invalidLifecycle('configure may be called once before start');
    }
    this.#declarations.configure(validateConfiguration(configuration));
    this.#configured = true;
  }

  start(options: StartOptions = {}): Promise<ReadySession> {
    if (this.#started || this.#status !== 'idle') {
      return Promise.reject(invalidLifecycle('Coordinator has already started or stopped'));
    }
    const signal = validateStartOptions(options);
    if (signal?.aborted === true) return Promise.reject(cancelled('not_dispatched'));
    this.#started = true;
    this.#startDeferred = createDeferred();
    if (signal !== undefined) {
      const abort = () => void this.stop();
      this.#startSignal = signal;
      this.#startAbort = abort;
      signal.addEventListener('abort', abort, { once: true });
    }
    this.#loopTask = this.#runConnectionLoop();
    void this.#loopTask.catch((error) => {
      const failure = error instanceof CoordinatorError ? error : internalFailure();
      this.#startDeferred?.reject(failure);
      this.#emitFailure(failure);
      void this.stop();
    });
    return this.#startDeferred.promise;
  }

  stop(options: StopOptions = {}): Promise<void> {
    if (this.#stopDeferred !== undefined) return this.#stopDeferred.promise;
    let deadlineMs: number;
    try {
      deadlineMs = validateStopOptions(options);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#stopDeferred = createDeferred();
    const stoppingFailure = cancelled('not_dispatched', 'Coordinator is stopping');
    this.#transition('stopping');
    this.calls.stop();
    this.#declarations.stop();
    this.state.stop(stoppingFailure);
    this.events.stop();
    this.presence.stop();
    this.#clearReauthentication();
    this.#abortTokenRequest();
    this.#loopController.abort(stoppingFailure);
    this.#sessionEnd?.resolve({ failure: stoppingFailure });
    this.#session?.terminate();
    this.#startDeferred?.reject(stoppingFailure);
    const finish = () => this.#finishStop();
    if (this.#loopTask === undefined) finish();
    else {
      this.#stopTimer = this.#runtime.setTimer(finish, deadlineMs);
      void this.#loopTask.then(finish, finish);
    }
    return this.#stopDeferred.promise;
  }

  subscribe(listener: (event: LifecycleEvent) => void): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('lifecycle listener must be a function');
    return this.#lifecycleListeners.subscribe(listener);
  }

  nextRequestId(): number {
    return this.#requestIds.take();
  }

  nextEventId(): number {
    return this.#eventIds.take();
  }

  nextCallId(): number {
    return this.#callIds.take();
  }

  nextLocalEventId(): number {
    return this.#localEventIds.take();
  }

  nextLocalCallId(): number {
    return this.#localCallIds.take();
  }

  currentSession(): RelaySession | undefined {
    return this.#status === 'ready' || this.#status === 'synchronizing'
      ? this.#session
      : undefined;
  }

  readySession(): RelaySession | undefined {
    return this.#status === 'ready' ? this.#session : undefined;
  }

  activeDeclarations(): ActiveDeclarations | undefined {
    return this.#declarations.active;
  }

  runtime(): CoordinatorRuntime {
    return this.#runtime;
  }

  logger(): CoordinatorLogger | undefined {
    return this.#options.logger;
  }

  emitFailure(failure: CoordinatorError): void {
    this.#emitFailure(failure);
  }

  synchronizing(): void {
    this.#transition('synchronizing');
  }

  activeDeclarationsChanged(active: ActiveDeclarations): void {
    this.calls.setActiveDeclarations(active);
  }

  declarationsReady(_receipt: DeclarationReceipt): void {
    const session = this.#session;
    if (session === undefined) return;
    const ready = session.welcome.readySession;
    this.#transition('ready', ready);
    this.#startDeferred?.resolve(ready);
  }

  declarationFailure(
    failure: CoordinatorError,
    hasActiveConfiguration: boolean,
    hasQueuedSnapshot: boolean,
  ): void {
    this.#emitFailure(failure);
    if (hasActiveConfiguration && !hasQueuedSnapshot && this.#session !== undefined) {
      const ready = this.#session.welcome.readySession;
      this.#transition('ready', ready, failure);
    }
  }

  transportFailure(error: unknown): void {
    const failure = error instanceof CoordinatorError
      ? error
      : unavailable('Coordinator transport failed');
    this.#sessionEnd?.resolve({ failure });
    this.#session?.terminate();
  }

  async #runConnectionLoop(): Promise<void> {
    let reason: AccessTokenRequest['reason'] = 'initial';
    while (!this.#loopController.signal.aborted) {
      let end: SessionEnd = {};
      let sessionEnd: Deferred<SessionEnd> | undefined;
      try {
        this.#transition('connecting');
        if (this.#loopController.signal.aborted) break;
        const token = await this.#getAccessToken(reason);
        this.#relayHost = new URL(token.relayUrl).host;
        if (this.#loopController.signal.aborted) break;
        this.#transition('authenticating');
        if (this.#loopController.signal.aborted) break;
        this.#requestIds = new IdSequence();
        this.#eventIds = new IdSequence();
        this.#callIds = new IdSequence();
        const connectionEnd = createDeferred<SessionEnd>();
        sessionEnd = connectionEnd;
        this.#sessionEnd = connectionEnd;
        this.#goawayRetryAfterMs = undefined;
        const session = await RelaySession.connect(
          this.#runtime,
          this.#options.name,
          token.relayUrl,
          token.token,
          this.#loopController.signal,
          {
            frame: (frame) => this.#handleFrame(frame),
            closed: () => {
              const retryAfterMs = this.#goawayRetryAfterMs;
              connectionEnd.resolve(retryAfterMs === undefined ? {} : { retryAfterMs });
            },
            failed: (error) => connectionEnd.resolve({
              failure: error instanceof CoordinatorError
                ? error
                : unavailable('Relay connection failed'),
            }),
          },
        );
        if (this.#loopController.signal.aborted) {
          session.terminate();
          session.detach();
          break;
        }
        this.#session = session;
        this.#reconnectAttempt = 0;
        this.#scheduleReauthentication(Math.min(token.expiresAtMs, session.welcome.expiresAtMs));
        this.#declarations.synchronize(session);
        if (this.#loopController.signal.aborted) {
          session.terminate();
          break;
        }
        session.startDelivery();
        end = await connectionEnd.promise;
      } catch (error) {
        if (this.#loopController.signal.aborted) break;
        end = sessionEnd?.settled === true
          ? await sessionEnd.promise
          : { failure: error instanceof CoordinatorError ? error : unavailable('Connection attempt failed') };
      }
      this.#disconnectSession();
      if (this.#loopController.signal.aborted) break;
      if (end.failure !== undefined) this.#emitFailure(end.failure);
      this.#transition('reconnecting', undefined, end.failure);
      const ceiling = Math.min(
        FIRST_RECONNECT_CEILING_MS * (2 ** this.#reconnectAttempt),
        MAX_RECONNECT_CEILING_MS,
      );
      this.#reconnectAttempt += 1;
      const randomDelay = Math.floor(this.#runtime.random() * (ceiling + 1));
      const reconnectDelay = Math.max(randomDelay, end.retryAfterMs ?? 0);
      try {
        await delay(this.#runtime, reconnectDelay, this.#loopController.signal);
      } catch {
        break;
      }
      reason = 'reconnect';
    }
  }

  async #getAccessToken(reason: AccessTokenRequest['reason']): Promise<AccessToken> {
    if (this.#tokenRequest !== undefined) return this.#tokenRequest.promise;
    const child = childAbortController(this.#loopController.signal);
    const request: AccessTokenRequest = this.#relayHost === undefined
      ? Object.freeze({
        coordinatorName: this.#options.name,
        reason,
        signal: child.controller.signal,
      })
      : Object.freeze({
        coordinatorName: this.#options.name,
        reason,
        relayHost: this.#relayHost,
        signal: child.controller.signal,
      });
    const promise = Promise.resolve()
      .then(() => this.#options.accessTokenProvider.getAccessToken(request))
      .then((value) => validateAccessToken(value, this.#runtime.now()));
    const tokenRequest: TokenRequest = {
      controller: child.controller,
      dispose: child.dispose,
      promise,
    };
    this.#tokenRequest = tokenRequest;
    void promise.finally(() => {
      if (this.#tokenRequest !== tokenRequest) return;
      child.dispose();
      this.#tokenRequest = undefined;
    }).catch(() => undefined);
    return promise;
  }

  #abortTokenRequest(): void {
    const request = this.#tokenRequest;
    if (request === undefined) return;
    request.controller.abort(cancelled('not_dispatched'));
    request.dispose();
    this.#tokenRequest = undefined;
  }

  #scheduleReauthentication(expiresAtMs: number): void {
    this.#clearReauthentication();
    if (this.#status === 'draining'
      || this.#status === 'stopping'
      || this.#status === 'stopped') return;
    const remaining = Math.max(0, expiresAtMs - this.#runtime.now());
    const lead = Math.min(30_000, Math.floor(remaining / 2));
    this.#reauthTimer = this.#runtime.setTimer(() => {
      void this.#reauthenticate();
    }, Math.max(0, remaining - lead));
  }

  async #reauthenticate(): Promise<void> {
    const session = this.#session;
    if (session === undefined || this.#loopController.signal.aborted) return;
    try {
      const token = await this.#getAccessToken('reauth');
      if (!this.#mayReauthenticate(session)) return;
      if (new URL(token.relayUrl).host !== this.#relayHost) {
        throw new TypeError('Reauthentication cannot change relay host');
      }
      const requestId = this.nextRequestId();
      const deferred = createDeferred<number>();
      this.#reauthentication = { requestId, deferred };
      await session.send({ opcode: Opcode.Reauth, payload: [requestId, token.token] });
      const relayExpiry = await deferred.promise;
      if (!this.#mayReauthenticate(session)) return;
      this.#scheduleReauthentication(Math.min(token.expiresAtMs, relayExpiry));
    } catch (error) {
      if (this.#mayReauthenticate(session)) this.transportFailure(error);
    }
  }

  #mayReauthenticate(session: RelaySession): boolean {
    return this.#session === session
      && !this.#loopController.signal.aborted
      && this.#status !== 'draining';
  }

  #clearReauthentication(): void {
    this.#reauthTimer?.cancel();
    this.#reauthTimer = undefined;
    this.#reauthentication?.deferred.reject(cancelled('not_dispatched'));
    this.#reauthentication = undefined;
  }

  #handleFrame(frame: Frame): void {
    try {
      if (frame.opcode === Opcode.Error) {
        this.#handleRelayError(frame);
        return;
      }
      if (frame.opcode === Opcode.Fatal) {
        const code = relayInteger(frame, 1, 'FATAL.code');
        const retryable = relayBoolean(frame, 2, 'FATAL.retryable');
        const failure = relayFailure(code, retryable, 'not_dispatched');
        if (retryable) this.transportFailure(failure);
        else {
          this.#emitFailure(failure);
          this.#startDeferred?.reject(failure);
          void this.stop();
        }
        return;
      }
      if (frame.opcode === Opcode.ReauthOk) {
        const requestId = relayInteger(frame, 0, 'REAUTH_OK.requestId');
        if (this.#reauthentication?.requestId !== requestId) {
          throw protocolFailure('REAUTH_OK is not correlated');
        }
        const expiresAtMs = relayInteger(frame, 1, 'REAUTH_OK.expiresAtMs');
        if (expiresAtMs <= this.#runtime.now()) {
          throw protocolFailure('REAUTH_OK expiry is not in the future');
        }
        this.#reauthentication.deferred.resolve(expiresAtMs);
        this.#reauthentication = undefined;
        return;
      }
      if (frame.opcode === Opcode.Goaway) {
        this.#transition('draining');
        this.#reauthTimer?.cancel();
        this.#reauthTimer = undefined;
        this.#abortTokenRequest();
        this.#goawayRetryAfterMs = relayInteger(frame, 0, 'GOAWAY.retryAfterMs');
        return;
      }
      if (frame.opcode === Opcode.StateDict || frame.opcode === Opcode.TopicDict) return;
      if (this.#declarations.handleFrame(frame)
        || this.state.handleFrame(frame)
        || this.events.handleFrame(frame)
        || this.calls.handleFrame(frame)
        || this.presence.handleFrame(frame)) return;
      throw protocolFailure('Relay sent an unsupported coordinator frame');
    } catch (error) {
      const failure = error instanceof CoordinatorError ? error : protocolFailure();
      this.transportFailure(failure);
    }
  }

  #handleRelayError(frame: Frame): void {
    const correlationId = relayInteger(frame, 0, 'ERROR.correlationId');
    const sourceOpcode = relayInteger(frame, 1, 'ERROR.sourceOpcode');
    const code = relayInteger(frame, 2, 'ERROR.code');
    const retryable = relayBoolean(frame, 3, 'ERROR.retryable');
    if (sourceOpcode === Opcode.Event && this.events.handleError(correlationId, code, retryable)) return;
    if (sourceOpcode === Opcode.StateSet && this.state.handleError(correlationId, code, retryable)) return;
    if ((sourceOpcode === Opcode.StateSync
      || sourceOpcode === Opcode.StateAclSync
      || sourceOpcode === Opcode.EventSync
      || sourceOpcode === Opcode.EventAclSync
      || sourceOpcode === Opcode.FunctionSync)
      && this.#declarations.handleError(correlationId, code, retryable)) return;
    if ((sourceOpcode === Opcode.Call
      || sourceOpcode === Opcode.CallCancel
      || sourceOpcode === Opcode.CallCredit)
      && this.calls.handleError(correlationId, code, retryable)) return;
    if ((sourceOpcode === Opcode.CallResult || sourceOpcode === Opcode.CallError)
      && this.calls.handleResponseError(correlationId, code, retryable)) return;
    if (sourceOpcode === Opcode.Reauth
      && this.#reauthentication?.requestId === correlationId) {
      const failure = relayFailure(code, retryable, 'not_dispatched');
      this.#reauthentication.deferred.reject(failure);
      this.#reauthentication = undefined;
      return;
    }
    if (correlationId !== 0 || sourceOpcode !== 0) {
      throw protocolFailure('ERROR is not correlated to an active operation');
    }
    this.#emitFailure(relayFailure(code, retryable, 'not_dispatched'));
  }

  #disconnectSession(): void {
    this.#clearReauthentication();
    this.#abortTokenRequest();
    this.#declarations.disconnected();
    this.state.disconnected();
    this.events.disconnected();
    this.calls.disconnected();
    this.presence.disconnected();
    this.#session?.detach();
    this.#session = undefined;
    this.#sessionEnd = undefined;
    this.#goawayRetryAfterMs = undefined;
  }

  #emitFailure(failure: CoordinatorFailure): void {
    this.#errorListeners.emit(failure, () => {
      safeLog(this.#options.logger, { level: 'error', event: 'error_listener_failed' });
    });
  }

  #transition(
    current: CoordinatorStatus,
    session?: ReadySession,
    reason?: CoordinatorFailure,
  ): void {
    if (this.#status === current) return;
    const previous = this.#status;
    this.#status = current;
    const event: LifecycleEvent = session === undefined && reason === undefined
      ? Object.freeze({ previous, current })
      : session === undefined
        ? Object.freeze({ previous, current, reason })
        : reason === undefined
          ? Object.freeze({ previous, current, session })
          : Object.freeze({ previous, current, session, reason });
    safeLog(this.#options.logger, { level: 'info', event: 'status_changed', status: current });
    this.#lifecycleListeners.emit(event, () => {
      safeLog(this.#options.logger, { level: 'error', event: 'lifecycle_listener_failed' });
    });
  }

  #finishStop(): void {
    if (this.#status === 'stopped') return;
    this.#stopTimer?.cancel();
    this.#stopTimer = undefined;
    this.#disconnectSession();
    if (this.#startSignal !== undefined && this.#startAbort !== undefined) {
      this.#startSignal.removeEventListener('abort', this.#startAbort);
    }
    this.#transition('stopped');
    this.#stopDeferred?.resolve();
    this.#lifecycleListeners.clear();
    this.#errorListeners.clear();
  }
}

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  return new CoordinatorImpl(validateCoordinatorOptions(options), createProductionRuntime());
}

/** @internal */
export function createCoordinatorWithRuntime(
  options: CoordinatorOptions,
  runtime: CoordinatorRuntime,
): Coordinator {
  return new CoordinatorImpl(validateCoordinatorOptions(options), runtime);
}
