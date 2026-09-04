import type {
  DispatchOutcome,
  ProtocolValue,
  StartOptions,
  StopOptions,
  Unsubscribe,
} from './api.js';

export type BrowserClientStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'synchronizing'
  | 'ready'
  | 'reconnecting'
  | 'draining'
  | 'stopping'
  | 'stopped';

export type BrowserRelayCredentialReason = 'initial' | 'reauth' | 'reconnect';

export interface BrowserRelayCredentialRequest {
  readonly homeId: string;
  readonly reason: BrowserRelayCredentialReason;
  readonly signal: AbortSignal;
}

export interface BrowserRelayCredential {
  readonly relayUrl: string;
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export interface BrowserRelayCredentialProvider {
  getCredential(request: BrowserRelayCredentialRequest): Promise<BrowserRelayCredential>;
}

export interface ControlPlaneBrowserRelayCredentialProviderOptions {
  readonly exchangeEndpoint: string;
  readonly getFirebaseIdToken:
    (request: BrowserRelayCredentialRequest) => Promise<string>;
  readonly getAppCheckToken:
    (request: BrowserRelayCredentialRequest) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BrowserClientLogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly status?: BrowserClientStatus;
  readonly code?: number;
}

export interface BrowserClientLogger {
  write(record: BrowserClientLogRecord): void;
}

export interface BrowserClientOptions {
  readonly homeId: string;
  readonly credentialProvider: BrowserRelayCredentialProvider;
  readonly logger?: BrowserClientLogger;
}

export interface BrowserCoordinatorStatus {
  readonly name: string;
  readonly generation: number;
  readonly status: 'connected' | 'grace';
}

export interface BrowserReadySession {
  readonly sessionId: number;
  readonly connectedAtMs: number;
  readonly enrolled: boolean;
  readonly coordinators: readonly BrowserCoordinatorStatus[];
}

export interface BrowserHomeStatus {
  readonly enrolled: boolean;
  readonly coordinators: readonly BrowserCoordinatorStatus[];
  readonly stale: boolean;
}

export interface BrowserHome {
  snapshot(): BrowserHomeStatus | undefined;
  subscribe(listener: (status: BrowserHomeStatus) => void): Unsubscribe;
}

export interface BrowserClientFailure extends Error {
  readonly kind:
    | 'protocol'
    | 'authentication'
    | 'authorization'
    | 'conflict'
    | 'invalid_lifecycle'
    | 'unavailable'
    | 'cancelled'
    | 'internal';
  readonly code?: number;
  readonly retryable: boolean;
  readonly outcome: DispatchOutcome;
  readonly correlation?: {
    readonly kind: 'call';
    readonly localId: string;
  };
}

export interface BrowserLifecycleEvent {
  readonly previous: BrowserClientStatus;
  readonly current: BrowserClientStatus;
  readonly session?: BrowserReadySession;
  readonly reason?: BrowserClientFailure;
}

export interface BrowserStateSnapshot {
  readonly epoch: Uint8Array;
  readonly revision: number;
  readonly values: Readonly<Record<string, ProtocolValue>>;
  readonly stale: boolean;
}

export interface BrowserState {
  snapshot(): BrowserStateSnapshot | undefined;
  subscribe(listener: (snapshot: BrowserStateSnapshot) => void): Unsubscribe;
}

export interface BrowserCallOptions {
  readonly function: string;
  readonly arguments: ProtocolValue;
  readonly timeoutMs: number;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface BrowserCallHandle {
  readonly localId: string;
  readonly accepted: Promise<void>;
  readonly result: Promise<ProtocolValue>;
  cancel(): void;
}

export interface BrowserCalls {
  start(options: BrowserCallOptions): BrowserCallHandle;
}

export interface BrowserClientErrors {
  subscribe(listener: (failure: BrowserClientFailure) => void): Unsubscribe;
}

export interface BrowserClient {
  readonly status: BrowserClientStatus;
  readonly home: BrowserHome;
  readonly state: BrowserState;
  readonly calls: BrowserCalls;
  readonly errors: BrowserClientErrors;

  start(options?: StartOptions): Promise<BrowserReadySession>;
  stop(options?: StopOptions): Promise<void>;
  subscribe(listener: (event: BrowserLifecycleEvent) => void): Unsubscribe;
}

export type BrowserClientFactory = (options: BrowserClientOptions) => BrowserClient;
