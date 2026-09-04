import type {
  StartOptions,
  StopOptions,
  Unsubscribe,
} from './api.js';
import type {
  BrowserClient,
  BrowserClientErrors,
  BrowserClientFailure,
  BrowserClientOptions,
  BrowserClientStatus,
  BrowserHome,
  BrowserHomeStatus,
  BrowserLifecycleEvent,
  BrowserReadySession,
  BrowserRelayCredential,
  BrowserRelayCredentialReason,
  BrowserRelayCredentialRequest,
} from './browser-api.js';
import { createBrowserRuntime } from './internal/browser-socket.js';
import {
  BrowserClientError,
  browserCancelled,
  browserInternalFailure,
  browserInvalidLifecycle,
  browserProtocolFailure,
  browserRelayFailure,
  browserUnavailable,
  safeBrowserLog,
} from './internal/browser-errors.js';
import { UserCallManager, type UserCallHost } from './internal/user-calls.js';
import {
  childAbortController,
  createDeferred,
  IdSequence,
  ListenerSet,
  type Deferred,
} from './internal/resources.js';
import { delay, type BrowserRuntime, type RuntimeTimer } from './internal/runtime.js';
import { parseUserHomeStatus, UserRelaySession } from './internal/user-session.js';
import { UserStateManager, type UserStateHost } from './internal/user-state.js';
import {
  validateBrowserClientOptions,
  validateBrowserRelayCredential,
  validateStartOptions,
  validateStopOptions,
} from './internal/validation.js';
import { Opcode, type Frame, type ProtocolValue } from './protocol/codec.js';

interface SessionEnd {
  readonly failure?: BrowserClientFailure;
  readonly retryAfterMs?: number;
  readonly handoffCredential?: BrowserRelayCredential;
}

interface CredentialRequest {
  readonly controller: AbortController;
  readonly dispose: Unsubscribe;
  readonly promise: Promise<BrowserRelayCredential>;
}

interface PendingReauthentication {
  readonly requestId: number;
  readonly maximumExpiresAtMs: number;
  readonly deferred: Deferred<number>;
  readonly timer: RuntimeTimer;
}

const FIRST_RECONNECT_CEILING_MS = 1_000;
const MAX_RECONNECT_CEILING_MS = 30_000;
const SESSION_PHASE_TIMEOUT_MS = 10_000;

function relayInteger(frame: Frame, index: number, label: string, minimum = 0): number {
  const value = frame.payload[index];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw browserProtocolFailure(`${label} is not an integer`);
  }
  return value;
}

function relayBoolean(frame: Frame, index: number, label: string): boolean {
  const value = frame.payload[index];
  if (typeof value !== 'boolean') throw browserProtocolFailure(`${label} is not a boolean`);
  return value;
}

function sameEpoch(left: Uint8Array, right: ProtocolValue | undefined): boolean {
  return right instanceof Uint8Array
    && right.length === left.length
    && right.every((value, index) => value === left[index]);
}

class BrowserClientImpl implements BrowserClient, UserStateHost, UserCallHost {
  readonly #options: BrowserClientOptions;
  readonly #runtime: BrowserRuntime;
  readonly #lifecycleListeners = new ListenerSet<BrowserLifecycleEvent>();
  readonly #errorListeners = new ListenerSet<BrowserClientFailure>();
  readonly #homeListeners = new ListenerSet<BrowserHomeStatus>();
  readonly #loopController = new AbortController();
  readonly home: BrowserHome;
  readonly state: UserStateManager;
  readonly calls: UserCallManager;
  readonly errors: BrowserClientErrors;
  #status: BrowserClientStatus = 'idle';
  #started = false;
  #session: UserRelaySession | undefined;
  #sessionEnd: Deferred<SessionEnd> | undefined;
  #sessionReady: Deferred<void> | undefined;
  #startDeferred: Deferred<BrowserReadySession> | undefined;
  #stopDeferred: Deferred<void> | undefined;
  #stopTimer: RuntimeTimer | undefined;
  #bootstrapTimer: RuntimeTimer | undefined;
  #loopTask: Promise<void> | undefined;
  #startSignal: AbortSignal | undefined;
  #startAbort: (() => void) | undefined;
  #credentialRequest: CredentialRequest | undefined;
  #reauthentication: PendingReauthentication | undefined;
  #reauthTimer: RuntimeTimer | undefined;
  #sessionRelayUrl: string | undefined;
  #requestIds = new IdSequence();
  #callIds = new IdSequence();
  readonly #localCallIds = new IdSequence();
  #reconnectAttempt = 0;
  #goawayRetryAfterMs: number | undefined;
  #stateReady = false;
  #functionReady = false;
  #topicReady = false;
  #homeStatus: BrowserHomeStatus | undefined;

  constructor(options: BrowserClientOptions, runtime: BrowserRuntime) {
    this.#options = options;
    this.#runtime = runtime;
    this.state = new UserStateManager(this);
    this.calls = new UserCallManager(this);
    this.home = Object.freeze({
      snapshot: () => this.#homeStatus,
      subscribe: (listener: (status: BrowserHomeStatus) => void) => this.#subscribeHome(listener),
    });
    this.errors = Object.freeze({
      subscribe: (listener: (failure: BrowserClientFailure) => void) => {
        if (typeof listener !== 'function') throw new TypeError('error listener must be a function');
        return this.#errorListeners.subscribe(listener);
      },
    });
  }

  get status(): BrowserClientStatus {
    return this.#status;
  }

  start(options: StartOptions = {}): Promise<BrowserReadySession> {
    if (this.#started || this.#status !== 'idle') {
      return Promise.reject(browserInvalidLifecycle('Browser client has already started or stopped'));
    }
    const signal = validateStartOptions(options);
    if (signal?.aborted === true) return Promise.reject(browserCancelled('not_dispatched'));
    this.#started = true;
    this.#startDeferred = createDeferred();
    if (signal !== undefined) {
      const abort = () => void this.stop();
      this.#startSignal = signal;
      this.#startAbort = abort;
      signal.addEventListener('abort', abort, { once: true });
    }
    this.#loopTask = this.#runConnectionLoop();
    void this.#loopTask.catch(() => {
      const failure = browserInternalFailure();
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
    const stopping = browserCancelled('not_dispatched', 'Browser client is stopping');
    this.#transition('stopping');
    this.calls.stop();
    this.state.stop();
    this.#markHomeStale();
    this.#clearReauthentication();
    this.#abortCredentialRequest();
    this.#loopController.abort(stopping);
    this.#sessionReady?.reject(stopping);
    this.#sessionEnd?.resolve({ failure: stopping });
    this.#session?.terminate();
    this.#startDeferred?.reject(stopping);
    const finish = () => this.#finishStop();
    if (this.#loopTask === undefined) finish();
    else {
      this.#stopTimer = this.#runtime.setTimer(finish, deadlineMs);
      void this.#loopTask.then(finish, finish);
    }
    return this.#stopDeferred.promise;
  }

  subscribe(listener: (event: BrowserLifecycleEvent) => void): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('lifecycle listener must be a function');
    return this.#lifecycleListeners.subscribe(listener);
  }

  nextRequestId(): number {
    return this.#requestIds.take();
  }

  nextCallId(): number {
    return this.#callIds.take();
  }

  nextLocalCallId(): number {
    return this.#localCallIds.take();
  }

  runtime(): BrowserRuntime {
    return this.#runtime;
  }

  readySession(): UserRelaySession | undefined {
    return this.#status === 'ready' ? this.#session : undefined;
  }

  send(frame: Frame): Promise<void> {
    const session = this.#session;
    if (session === undefined || (this.#status !== 'ready' && this.#status !== 'synchronizing')) {
      return Promise.reject(browserUnavailable());
    }
    return session.send(frame);
  }

  stateSynchronized(): void {
    this.#stateReady = true;
    this.#maybeReady();
  }

  functionDictionarySynchronized(): void {
    this.#functionReady = true;
    this.#maybeReady();
  }

  transportFailure(error: Error): void {
    const failure = error instanceof BrowserClientError
      ? error
      : browserUnavailable('Browser relay transport failed');
    this.#sessionReady?.reject(failure);
    this.#sessionEnd?.resolve({ failure });
    this.#session?.terminate();
  }

  emitFailure(failure: BrowserClientError): void {
    this.#emitFailure(failure);
  }

  async #runConnectionLoop(): Promise<void> {
    let reason: BrowserRelayCredentialReason = 'initial';
    let pendingCredential: BrowserRelayCredential | undefined;
    while (!this.#loopController.signal.aborted) {
      let end: SessionEnd = {};
      let connectionEnd: Deferred<SessionEnd> | undefined;
      try {
        this.#transition('connecting');
        if (this.#loopController.signal.aborted) break;
        const credential = pendingCredential ?? await this.#getCredential(reason);
        pendingCredential = undefined;
        if (this.#loopController.signal.aborted) break;
        if (credential.expiresAtMs <= this.#runtime.now()) {
          throw browserUnavailable('Browser relay credential expired before connection');
        }
        this.#transition('authenticating');
        if (this.#loopController.signal.aborted) break;
        this.#requestIds = new IdSequence();
        this.#callIds = new IdSequence();
        connectionEnd = createDeferred<SessionEnd>();
        const sessionReady = createDeferred<void>();
        void sessionReady.promise.catch(() => undefined);
        this.#sessionEnd = connectionEnd;
        this.#sessionReady = sessionReady;
        this.#goawayRetryAfterMs = undefined;
        const session = await UserRelaySession.connect(
          this.#runtime,
          this.#options.homeId,
          credential.relayUrl,
          credential.accessToken,
          this.#loopController.signal,
          {
            frame: (frame) => this.#handleFrame(frame),
            closed: () => {
              const failure = browserUnavailable('Browser relay connection closed');
              sessionReady.reject(failure);
              connectionEnd?.resolve(this.#goawayRetryAfterMs === undefined
                ? { failure }
                : { failure, retryAfterMs: this.#goawayRetryAfterMs });
            },
            failed: (error) => {
              const failure = error instanceof BrowserClientError
                ? error
                : browserUnavailable('Browser relay connection failed');
              sessionReady.reject(failure);
              connectionEnd?.resolve({ failure });
            },
          },
        );
        if (this.#loopController.signal.aborted) {
          session.terminate();
          session.detach();
          break;
        }
        if (credential.expiresAtMs <= this.#runtime.now()) {
          session.terminate();
          session.detach();
          throw browserUnavailable('Browser relay credential expired during authentication');
        }
        this.#reconnectAttempt = 0;
        this.#session = session;
        this.#sessionRelayUrl = credential.relayUrl;
        this.#setHomeStatus(Object.freeze({
          enrolled: session.welcome.readySession.enrolled,
          coordinators: session.welcome.readySession.coordinators,
          stale: false,
        }));
        if (this.#loopController.signal.aborted) break;
        this.#stateReady = false;
        this.#functionReady = false;
        this.#topicReady = false;
        this.state.beginSession(session.welcome.epoch);
        this.calls.beginSession(session.welcome.epoch);
        this.#transition('synchronizing');
        if (this.#loopController.signal.aborted) break;
        this.#scheduleReauthentication(Math.min(
          session.welcome.expiresAtMs,
          credential.expiresAtMs,
        ));
        const bootstrapTimeout = this.#runtime.setTimer(() => {
          const failure = browserUnavailable('Browser relay bootstrap timed out');
          sessionReady.reject(failure);
          connectionEnd?.resolve({ failure });
          session.terminate();
        }, SESSION_PHASE_TIMEOUT_MS);
        this.#bootstrapTimer = bootstrapTimeout;
        session.startDelivery();
        try {
          await Promise.race([
            sessionReady.promise,
            connectionEnd.promise.then((closed) => Promise.reject(
              closed.failure ?? browserUnavailable('Browser relay closed during synchronization'),
            )),
          ]);
        } finally {
          bootstrapTimeout.cancel();
          if (this.#bootstrapTimer === bootstrapTimeout) this.#bootstrapTimer = undefined;
        }
        if (this.#loopController.signal.aborted) break;
        end = await connectionEnd.promise;
      } catch (error) {
        if (this.#loopController.signal.aborted) break;
        end = connectionEnd?.settled === true
          ? await connectionEnd.promise
          : { failure: error instanceof BrowserClientError
            ? error
            : browserUnavailable('Browser relay connection attempt failed') };
      }
      this.#disconnectSession();
      if (this.#loopController.signal.aborted) break;
      if (end.failure !== undefined) this.#emitFailure(end.failure);
      if (this.#loopController.signal.aborted) break;
      this.#transition('reconnecting', undefined, end.failure);
      if (this.#loopController.signal.aborted) break;
      if (end.handoffCredential !== undefined) {
        pendingCredential = end.handoffCredential;
        reason = 'reconnect';
        continue;
      }
      const ceiling = Math.min(
        FIRST_RECONNECT_CEILING_MS * (2 ** this.#reconnectAttempt),
        MAX_RECONNECT_CEILING_MS,
      );
      this.#reconnectAttempt += 1;
      const randomDelay = Math.floor(this.#runtime.random() * (ceiling + 1));
      try {
        await delay(
          this.#runtime,
          Math.max(randomDelay, end.retryAfterMs ?? 0),
          this.#loopController.signal,
        );
      } catch {
        break;
      }
      reason = 'reconnect';
    }
  }

  async #getCredential(
    reason: BrowserRelayCredentialReason,
    timeoutMs = SESSION_PHASE_TIMEOUT_MS,
  ): Promise<BrowserRelayCredential> {
    if (this.#credentialRequest !== undefined) return this.#credentialRequest.promise;
    const child = childAbortController(this.#loopController.signal);
    const request: BrowserRelayCredentialRequest = Object.freeze({
      homeId: this.#options.homeId,
      reason,
      signal: child.controller.signal,
    });
    let abort: (() => void) | undefined;
    const interrupted = new Promise<BrowserRelayCredential>((_resolve, reject) => {
      abort = () => reject(child.controller.signal.reason ?? browserCancelled('not_dispatched'));
      if (child.controller.signal.aborted) abort();
      else child.controller.signal.addEventListener('abort', abort, { once: true });
    });
    const provider = Promise.resolve()
      .then(() => {
        if (child.controller.signal.aborted) {
          throw child.controller.signal.reason ?? browserCancelled('not_dispatched');
        }
        return this.#options.credentialProvider.getCredential(request);
      })
      .then((value) => validateBrowserRelayCredential(value, this.#runtime.now()))
      .catch(() => { throw browserUnavailable('Browser relay credential provider failed'); });
    const timeout = this.#runtime.setTimer(() => {
      child.controller.abort(browserUnavailable('Browser relay credential request timed out'));
    }, Math.max(1, Math.min(timeoutMs, SESSION_PHASE_TIMEOUT_MS)));
    const promise = Promise.race([provider, interrupted]);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      timeout.cancel();
      if (abort !== undefined) child.controller.signal.removeEventListener('abort', abort);
      child.dispose();
    };
    const credentialRequest = { controller: child.controller, dispose, promise };
    this.#credentialRequest = credentialRequest;
    void promise.finally(() => {
      dispose();
      if (this.#credentialRequest === credentialRequest) this.#credentialRequest = undefined;
    }).catch(() => undefined);
    return promise;
  }

  #abortCredentialRequest(): void {
    const request = this.#credentialRequest;
    if (request === undefined) return;
    request.controller.abort(browserCancelled('not_dispatched'));
    request.dispose();
    this.#credentialRequest = undefined;
  }

  #scheduleReauthentication(expiresAtMs: number): void {
    this.#clearReauthentication();
    if (this.#status === 'draining' || this.#status === 'stopping' || this.#status === 'stopped') return;
    const remaining = Math.max(0, expiresAtMs - this.#runtime.now());
    const lead = Math.min(30_000, Math.floor(remaining / 2));
    this.#reauthTimer = this.#runtime.setTimer(
      () => void this.#reauthenticate(expiresAtMs),
      remaining - lead,
    );
  }

  async #reauthenticate(currentExpiresAtMs: number): Promise<void> {
    const session = this.#session;
    if (session === undefined || this.#loopController.signal.aborted) return;
    try {
      const credential = await this.#getCredential(
        'reauth',
        Math.max(1, currentExpiresAtMs - this.#runtime.now()),
      );
      if (!this.#mayReauthenticate(session)) return;
      if (this.#sessionRelayUrl === undefined) {
        throw browserUnavailable('Browser relay routing state is unavailable');
      }
      if (credential.relayUrl !== this.#sessionRelayUrl) {
        if (this.#sessionEnd === undefined || this.#sessionEnd.settled) {
          throw browserUnavailable('Browser relay handoff state is unavailable');
        }
        this.#sessionEnd.resolve({ handoffCredential: credential });
        session.terminate();
        return;
      }
      const remaining = Math.min(currentExpiresAtMs, credential.expiresAtMs)
        - this.#runtime.now();
      if (remaining <= 0) throw browserUnavailable('Browser authentication lease expired');
      const requestId = this.nextRequestId();
      const deferred = createDeferred<number>();
      void deferred.promise.catch(() => undefined);
      const timer = this.#runtime.setTimer(() => {
        deferred.reject(browserUnavailable('Browser reauthentication timed out'));
      }, Math.max(1, Math.min(remaining, SESSION_PHASE_TIMEOUT_MS)));
      this.#reauthentication = {
        requestId,
        maximumExpiresAtMs: credential.expiresAtMs,
        deferred,
        timer,
      };
      await session.send({ opcode: Opcode.Reauth, payload: [requestId, credential.accessToken] });
      const expiresAtMs = await deferred.promise;
      if (this.#mayReauthenticate(session)) this.#scheduleReauthentication(expiresAtMs);
    } catch {
      if (this.#mayReauthenticate(session)) {
        this.transportFailure(browserUnavailable('Browser reauthentication failed'));
      }
    }
  }

  #mayReauthenticate(session: UserRelaySession): boolean {
    return this.#session === session
      && !this.#loopController.signal.aborted
      && this.#status !== 'draining';
  }

  #clearReauthentication(): void {
    this.#reauthTimer?.cancel();
    this.#reauthTimer = undefined;
    this.#reauthentication?.timer.cancel();
    this.#reauthentication?.deferred.reject(browserCancelled('not_dispatched'));
    this.#reauthentication = undefined;
  }

  #handleFrame(frame: Frame): void {
    try {
      if (frame.opcode >= 0x80) return;
      if (frame.opcode === Opcode.Error) {
        this.#handleRelayError(frame);
        return;
      }
      if (frame.opcode === Opcode.Fatal) {
        const code = relayInteger(frame, 1, 'FATAL.code', 1);
        const retryable = relayBoolean(frame, 2, 'FATAL.retryable');
        const failure = browserRelayFailure(code, retryable, 'not_dispatched');
        if (retryable) this.transportFailure(failure);
        else {
          this.#emitFailure(failure);
          this.#startDeferred?.reject(failure);
          void this.stop();
        }
        return;
      }
      if (frame.opcode === Opcode.ReauthOk) {
        const requestId = relayInteger(frame, 0, 'REAUTH_OK.requestId', 1);
        if (this.#reauthentication?.requestId !== requestId) {
          throw browserProtocolFailure('REAUTH_OK is not correlated');
        }
        const expiresAtMs = relayInteger(frame, 1, 'REAUTH_OK.expiresAtMs', 1);
        if (expiresAtMs <= this.#runtime.now()
          || expiresAtMs > this.#reauthentication.maximumExpiresAtMs) {
          throw browserProtocolFailure('REAUTH_OK expiry is outside the credential lease');
        }
        this.#reauthentication.timer.cancel();
        this.#reauthentication.deferred.resolve(expiresAtMs);
        this.#reauthentication = undefined;
        return;
      }
      if (frame.opcode === Opcode.Goaway) {
        this.#transition('draining');
        this.#reauthTimer?.cancel();
        this.#reauthTimer = undefined;
        this.#abortCredentialRequest();
        this.#goawayRetryAfterMs = relayInteger(frame, 0, 'GOAWAY.retryAfterMs');
        return;
      }
      if (frame.opcode === Opcode.HomeStatus) {
        this.#setHomeStatus(parseUserHomeStatus(frame.payload[0], frame.payload[1], false));
        return;
      }
      if (frame.opcode === Opcode.TopicDict) {
        if (this.#session === undefined || !sameEpoch(this.#session.welcome.epoch, frame.payload[0])) {
          throw browserProtocolFailure('TOPIC_DICT uses a stale epoch');
        }
        if (frame.payload[1] === true) {
          this.#topicReady = true;
          this.#maybeReady();
        }
        return;
      }
      if (this.state.handleFrame(frame) || this.calls.handleFrame(frame)) return;
      throw browserProtocolFailure('Relay sent an unsupported user frame');
    } catch (error) {
      this.transportFailure(error instanceof Error ? error : browserProtocolFailure());
    }
  }

  #handleRelayError(frame: Frame): void {
    const correlationId = relayInteger(frame, 0, 'ERROR.correlationId');
    const sourceOpcode = relayInteger(frame, 1, 'ERROR.sourceOpcode');
    const code = relayInteger(frame, 2, 'ERROR.code', 1);
    const retryable = relayBoolean(frame, 3, 'ERROR.retryable');
    if (sourceOpcode === Opcode.StateResync
      && this.state.handleError(correlationId, code, retryable)) return;
    if ((sourceOpcode === Opcode.Call || sourceOpcode === Opcode.CallCancel)
      && this.calls.handleError(correlationId, code, retryable)) return;
    if (sourceOpcode === Opcode.CallError
      && this.calls.handleResponseError(correlationId, code, retryable)) return;
    if (sourceOpcode === Opcode.Reauth && this.#reauthentication?.requestId === correlationId) {
      this.#reauthentication.timer.cancel();
      this.#reauthentication.deferred.reject(
        browserRelayFailure(code, retryable, 'not_dispatched'),
      );
      this.#reauthentication = undefined;
      return;
    }
    if (correlationId !== 0 || sourceOpcode !== 0) {
      throw browserProtocolFailure('ERROR is not correlated to an active operation');
    }
    this.#emitFailure(browserRelayFailure(code, retryable, 'not_dispatched'));
  }

  #maybeReady(): void {
    const session = this.#session;
    if (this.#status !== 'synchronizing'
      || !this.#stateReady
      || !this.#functionReady
      || !this.#topicReady
      || session === undefined) return;
    const ready = session.welcome.readySession;
    this.#bootstrapTimer?.cancel();
    this.#bootstrapTimer = undefined;
    this.#transition('ready', ready);
    this.#sessionReady?.resolve(undefined);
    this.#startDeferred?.resolve(ready);
  }

  #disconnectSession(): void {
    this.#bootstrapTimer?.cancel();
    this.#bootstrapTimer = undefined;
    this.#clearReauthentication();
    this.#abortCredentialRequest();
    this.state.disconnected();
    this.calls.disconnected();
    this.#markHomeStale();
    this.#session?.detach();
    this.#session = undefined;
    this.#sessionRelayUrl = undefined;
    this.#sessionEnd = undefined;
    this.#sessionReady = undefined;
    this.#goawayRetryAfterMs = undefined;
    this.#stateReady = false;
    this.#functionReady = false;
    this.#topicReady = false;
  }

  #emitFailure(failure: BrowserClientFailure): void {
    this.#errorListeners.emit(failure, () => {
      safeBrowserLog(this.#options.logger, { level: 'error', event: 'error_listener_failed' });
    });
  }

  #subscribeHome(listener: (status: BrowserHomeStatus) => void): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('home listener must be a function');
    const remove = this.#homeListeners.subscribe(listener);
    if (this.#homeStatus !== undefined) {
      try {
        listener(this.#homeStatus);
      } catch {
        this.#emitFailure(browserInternalFailure());
      }
    }
    return remove;
  }

  #setHomeStatus(status: BrowserHomeStatus): void {
    this.#homeStatus = status;
    this.#homeListeners.emit(status, () => this.#emitFailure(browserInternalFailure()));
  }

  #markHomeStale(): void {
    const status = this.#homeStatus;
    if (status === undefined || status.stale) return;
    this.#setHomeStatus(Object.freeze({ ...status, stale: true }));
  }

  #transition(
    current: BrowserClientStatus,
    session?: BrowserReadySession,
    reason?: BrowserClientFailure,
  ): void {
    if ((this.#status === 'stopping' || this.#status === 'stopped') && current !== 'stopped') return;
    if (this.#status === current) return;
    const previous = this.#status;
    this.#status = current;
    const event: BrowserLifecycleEvent = session === undefined && reason === undefined
      ? Object.freeze({ previous, current })
      : session === undefined
        ? Object.freeze({ previous, current, reason })
        : reason === undefined
          ? Object.freeze({ previous, current, session })
          : Object.freeze({ previous, current, session, reason });
    safeBrowserLog(this.#options.logger, { level: 'info', event: 'status_changed', status: current });
    this.#lifecycleListeners.emit(event, () => {
      safeBrowserLog(this.#options.logger, { level: 'error', event: 'lifecycle_listener_failed' });
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
    this.#stopDeferred?.resolve(undefined);
    this.#lifecycleListeners.clear();
    this.#errorListeners.clear();
    this.#homeListeners.clear();
  }
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  return new BrowserClientImpl(validateBrowserClientOptions(options), createBrowserRuntime());
}

/** @internal */
export function createBrowserClientWithRuntime(
  options: BrowserClientOptions,
  runtime: BrowserRuntime,
): BrowserClient {
  return new BrowserClientImpl(validateBrowserClientOptions(options), runtime);
}
