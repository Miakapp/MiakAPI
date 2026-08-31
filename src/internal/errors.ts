import type {
  CoordinatorFailure,
  CoordinatorLogRecord,
  CoordinatorLogger,
  DispatchOutcome,
} from '../api.js';

interface FailureOptions {
  code?: number;
  correlation?: {
    kind: 'event' | 'call';
    localId: string;
  };
  retryable?: boolean;
}

export class CoordinatorError extends Error implements CoordinatorFailure {
  readonly kind: CoordinatorFailure['kind'];
  readonly retryable: boolean;
  readonly outcome: DispatchOutcome;
  readonly code?: number;
  readonly correlation?: {
    kind: 'event' | 'call';
    localId: string;
  };

  constructor(
    kind: CoordinatorFailure['kind'],
    outcome: DispatchOutcome,
    message: string,
    options: FailureOptions = {},
  ) {
    super(message);
    this.name = 'CoordinatorFailure';
    this.kind = kind;
    this.outcome = outcome;
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.correlation !== undefined) {
      this.correlation = Object.freeze({ ...options.correlation });
    }
  }
}

export function invalidLifecycle(message: string): CoordinatorError {
  return new CoordinatorError('invalid_lifecycle', 'not_dispatched', message);
}

export function unavailable(message = 'Coordinator is not ready'): CoordinatorError {
  return new CoordinatorError('unavailable', 'not_dispatched', message, { retryable: true });
}

export function cancelled(
  outcome: 'not_dispatched' | 'outcome_unknown',
  message = 'Operation was cancelled',
): CoordinatorError {
  return new CoordinatorError('cancelled', outcome, message);
}

export function superseded(): CoordinatorError {
  return new CoordinatorError(
    'superseded',
    'not_dispatched',
    'Declaration was superseded by a newer desired snapshot',
  );
}

export function outcomeUnknown(message = 'Transport closed after operation handoff'): CoordinatorError {
  return new CoordinatorError('unavailable', 'outcome_unknown', message, { retryable: false });
}

export function internalFailure(message = 'Coordinator internal failure'): CoordinatorError {
  return new CoordinatorError('internal', 'not_dispatched', message);
}

export function protocolFailure(message = 'Relay protocol violation'): CoordinatorError {
  return new CoordinatorError('protocol', 'not_dispatched', message);
}

function kindFromCode(code: number): CoordinatorFailure['kind'] {
  if (code >= 1100 && code <= 1102) return 'authentication';
  if (code >= 1200 && code <= 1203) return 'authorization';
  if (code >= 1300 && code <= 1305) return 'conflict';
  if (code === 1405) return 'cancelled';
  if (code >= 1000 && code <= 1005) return 'protocol';
  if (code === 1500) return 'internal';
  return 'unavailable';
}

export function relayFailure(
  code: number,
  retryable: boolean,
  outcome: DispatchOutcome,
  correlation?: FailureOptions['correlation'],
): CoordinatorError {
  const options: FailureOptions = correlation === undefined
    ? { code, retryable }
    : { code, retryable, correlation };
  return new CoordinatorError(kindFromCode(code), outcome, 'Relay rejected the operation', options);
}

export function safeLog(logger: CoordinatorLogger | undefined, record: CoordinatorLogRecord): void {
  if (logger === undefined) return;
  try {
    logger.write(Object.freeze({ ...record }));
  } catch {
    // A diagnostic sink must never control coordinator execution.
  }
}
