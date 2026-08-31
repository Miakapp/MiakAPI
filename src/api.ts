export type ProtocolObject = { [key: string]: ProtocolValue };

const API_UTF8 = new TextEncoder();
const API_CONTROL_CHARACTER = /\p{Cc}/u;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export type ProtocolValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | ProtocolValue[]
  | ProtocolObject;

export type Unsubscribe = () => void;

export type CoordinatorStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'synchronizing'
  | 'ready'
  | 'reconnecting'
  | 'draining'
  | 'stopping'
  | 'stopped';

export type DispatchOutcome =
  | 'not_dispatched'
  | 'sent'
  | 'accepted'
  | 'applied'
  | 'outcome_unknown';

export interface AccessTokenRequest {
  coordinatorName: string;
  reason: 'initial' | 'reauth' | 'reconnect';
  relayHost?: string;
  signal: AbortSignal;
}

export interface AccessToken {
  relayUrl: string;
  token: string;
  expiresAtMs: number;
}

export interface AccessTokenProvider {
  getAccessToken(request: AccessTokenRequest): Promise<AccessToken>;
}

export interface CoordinatorLogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  status?: CoordinatorStatus;
  code?: number;
}

export interface CoordinatorLogger {
  write(record: CoordinatorLogRecord): void;
}

export interface CoordinatorOptions {
  name: string;
  accessTokenProvider: AccessTokenProvider;
  logger?: CoordinatorLogger;
}

export interface CoordinatorConfiguration {
  state: Readonly<Record<string, ProtocolValue>>;
  stateAccess: readonly UserStateAccess[];
  events: readonly EventDeclaration[];
  eventAccess: readonly UserEventAccess[];
  functions: Readonly<Record<string, FunctionHandler>>;
}

export interface ReadySession {
  sessionId: number;
  generation: number;
  connectedAtMs: number;
}

export interface CoordinatorFailure extends Error {
  kind:
    | 'protocol'
    | 'authentication'
    | 'authorization'
    | 'conflict'
    | 'invalid_lifecycle'
    | 'unavailable'
    | 'cancelled'
    | 'superseded'
    | 'internal';
  code?: number;
  retryable: boolean;
  outcome: DispatchOutcome;
  correlation?: {
    kind: 'event' | 'call';
    localId: string;
  };
}

export class ApplicationCallError extends Error {
  readonly code: number;
  readonly retryable: boolean;

  constructor(code: number, message = 'Application call failed', retryable = false) {
    if (!Number.isInteger(code) || code < 2_000 || code > 2_999) {
      throw new RangeError('Application call error code must be between 2000 and 2999');
    }
    if (typeof message !== 'string'
      || message.length === 0
      || hasUnpairedSurrogate(message)
      || API_CONTROL_CHARACTER.test(message)
      || API_UTF8.encode(message).byteLength > 256) {
      throw new TypeError('Application call error message must contain 1 to 256 safe UTF-8 bytes');
    }
    if (typeof retryable !== 'boolean') {
      throw new TypeError('Application call error retryable flag must be a boolean');
    }
    super(message);
    this.name = 'ApplicationCallError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface LifecycleEvent {
  previous: CoordinatorStatus;
  current: CoordinatorStatus;
  session?: ReadySession;
  reason?: CoordinatorFailure;
}

export interface StartOptions {
  signal?: AbortSignal;
}

export interface StopOptions {
  deadlineMs?: number;
}

export interface DeclarationOptions {
  signal?: AbortSignal;
}

export interface OperationOptions {
  signal?: AbortSignal;
}

export interface DeclarationReceipt {
  sessionId: number;
  generation: number;
}

export interface StateReceipt {
  outcome: 'applied';
}

export type StateMutation =
  | { path: string; value: ProtocolValue }
  | { path: string; delete: true };

export interface CoordinatorState {
  declare(
    entries: Readonly<Record<string, ProtocolValue>>,
    options?: DeclarationOptions,
  ): Promise<DeclarationReceipt>;

  set(
    mutations: readonly StateMutation[],
    options?: OperationOptions,
  ): Promise<StateReceipt>;
}

export interface UserStateAccess {
  userId: string;
  patterns: readonly string[];
}

export interface UserEventAccess {
  userId: string;
  publish: readonly string[];
  subscribe: readonly string[];
}

export interface CoordinatorAccess {
  declareState(
    entries: readonly UserStateAccess[],
    options?: DeclarationOptions,
  ): Promise<DeclarationReceipt>;

  declareEvents(
    entries: readonly UserEventAccess[],
    options?: DeclarationOptions,
  ): Promise<DeclarationReceipt>;
}

export const EventDirection = Object.freeze({
  acceptFromUsers: 0x01,
  publishToUsers: 0x02,
  acceptFromCoordinators: 0x04,
  publishToCoordinators: 0x08,
} as const);

export interface EventDeclaration {
  topic: string;
  directions: number;
}

export type EventTarget =
  | { kind: 'default' }
  | { kind: 'user_session'; id: number }
  | { kind: 'coordinator'; id: string };

export interface SentEvent {
  outcome: 'sent';
}

export interface EventHandle {
  readonly localId: string;
  readonly sent: Promise<SentEvent>;
}

export interface IncomingEvent {
  source: Principal;
  topic: string;
  value: ProtocolValue;
}

export interface CoordinatorEvents {
  declare(
    entries: readonly EventDeclaration[],
    options?: DeclarationOptions,
  ): Promise<DeclarationReceipt>;

  publish(
    topic: string,
    value: ProtocolValue,
    options?: OperationOptions & { target?: EventTarget },
  ): EventHandle;

  subscribe(topic: string, listener: (event: IncomingEvent) => void): Unsubscribe;
}

export interface Principal {
  kind: 'user' | 'coordinator' | 'cli';
  id: string;
  sessionId: number;
  coordinatorName: string | null;
  verifiedEmail: string | null;
}

export interface IncomingCall {
  source: Principal;
  arguments: ProtocolValue;
  idempotencyKey: string | null;
  signal: AbortSignal;
  emit(value: ProtocolValue): Promise<void>;
}

export type FunctionHandler = (
  call: IncomingCall,
) => ProtocolValue | Promise<ProtocolValue>;

export interface CoordinatorFunctions {
  declare(
    handlers: Readonly<Record<string, FunctionHandler>>,
    options?: DeclarationOptions,
  ): Promise<DeclarationReceipt>;
}

export type CallTarget =
  | { kind: 'default' }
  | { kind: 'user_session'; id: number }
  | { kind: 'coordinator'; id: string };

export interface StartCallOptions {
  function: string;
  arguments: ProtocolValue;
  timeoutMs: number;
  target?: CallTarget;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface CallHandle {
  readonly localId: string;
  readonly accepted: Promise<void>;
  readonly stream: AsyncIterable<ProtocolValue>;
  readonly result: Promise<ProtocolValue>;
  cancel(reason?: string): void;
}

export interface CoordinatorCalls {
  start(options: StartCallOptions): CallHandle;
}

export interface PresenceEntry {
  sessionId: number;
  userId: string;
}

export interface CoordinatorPresence {
  snapshot(): readonly PresenceEntry[];
  subscribe(listener: (entries: readonly PresenceEntry[]) => void): Unsubscribe;
}

export interface CoordinatorErrors {
  subscribe(listener: (failure: CoordinatorFailure) => void): Unsubscribe;
}

export interface Coordinator {
  readonly status: CoordinatorStatus;
  readonly state: CoordinatorState;
  readonly access: CoordinatorAccess;
  readonly events: CoordinatorEvents;
  readonly functions: CoordinatorFunctions;
  readonly calls: CoordinatorCalls;
  readonly presence: CoordinatorPresence;
  readonly errors: CoordinatorErrors;

  configure(configuration: CoordinatorConfiguration): void;
  start(options?: StartOptions): Promise<ReadySession>;
  stop(options?: StopOptions): Promise<void>;
  subscribe(listener: (event: LifecycleEvent) => void): Unsubscribe;
}

export type CoordinatorFactory = (options: CoordinatorOptions) => Coordinator;

export interface CoordinatorModule {
  createCoordinator: CoordinatorFactory;
}
