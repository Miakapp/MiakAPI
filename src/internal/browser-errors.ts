import type {
  BrowserClientFailure,
  BrowserClientLogRecord,
  BrowserClientLogger,
} from '../browser-api.js';
import type { DispatchOutcome } from '../api.js';

interface FailureOptions {
  readonly code?: number;
  readonly retryable?: boolean;
  readonly correlation?: {
    readonly kind: 'call';
    readonly localId: string;
  };
}

export class BrowserClientError extends Error implements BrowserClientFailure {
  readonly kind: BrowserClientFailure['kind'];
  readonly retryable: boolean;
  readonly outcome: DispatchOutcome;
  readonly code?: number;
  readonly correlation?: {
    readonly kind: 'call';
    readonly localId: string;
  };

  constructor(
    kind: BrowserClientFailure['kind'],
    outcome: DispatchOutcome,
    message: string,
    options: FailureOptions = {},
  ) {
    super(message);
    this.name = 'BrowserClientFailure';
    this.kind = kind;
    this.outcome = outcome;
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.correlation !== undefined) {
      this.correlation = Object.freeze({ ...options.correlation });
    }
  }
}

export function browserInvalidLifecycle(message: string): BrowserClientError {
  return new BrowserClientError('invalid_lifecycle', 'not_dispatched', message);
}

export function browserUnavailable(message = 'Browser client is not ready'): BrowserClientError {
  return new BrowserClientError('unavailable', 'not_dispatched', message, { retryable: true });
}

export function browserCancelled(
  outcome: 'not_dispatched' | 'outcome_unknown',
  message = 'Operation was cancelled',
): BrowserClientError {
  return new BrowserClientError('cancelled', outcome, message);
}

export function browserOutcomeUnknown(
  message = 'Transport closed after operation handoff',
): BrowserClientError {
  return new BrowserClientError('unavailable', 'outcome_unknown', message);
}

export function browserInternalFailure(): BrowserClientError {
  return new BrowserClientError('internal', 'not_dispatched', 'Browser client internal failure');
}

export function browserProtocolFailure(message = 'Relay protocol violation'): BrowserClientError {
  return new BrowserClientError('protocol', 'not_dispatched', message);
}

function kindFromCode(code: number): BrowserClientFailure['kind'] {
  if (code >= 1100 && code <= 1102) return 'authentication';
  if (code >= 1200 && code <= 1203) return 'authorization';
  if (code >= 1300 && code <= 1305) return 'conflict';
  if (code === 1405) return 'cancelled';
  if (code >= 1000 && code <= 1005) return 'protocol';
  if (code === 1500) return 'internal';
  return 'unavailable';
}

export function browserRelayFailure(
  code: number,
  retryable: boolean,
  outcome: DispatchOutcome,
  correlation?: FailureOptions['correlation'],
): BrowserClientError {
  const options: FailureOptions = correlation === undefined
    ? { code, retryable }
    : { code, retryable, correlation };
  return new BrowserClientError(kindFromCode(code), outcome, 'Relay rejected the operation', options);
}

export function safeBrowserLog(
  logger: BrowserClientLogger | undefined,
  record: BrowserClientLogRecord,
): void {
  if (logger === undefined) return;
  try {
    logger.write(Object.freeze({ ...record }));
  } catch {
    // Diagnostic sinks never control client execution.
  }
}
