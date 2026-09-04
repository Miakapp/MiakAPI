import type {
  CoordinatorFailure,
  CoordinatorStatus,
  DispatchOutcome,
} from '../../src/api.js';

export type DeclarationDomain =
  | 'state'
  | 'state_access'
  | 'events'
  | 'event_access'
  | 'functions';

export interface DeclarationRevisions {
  state: number;
  state_access: number;
  events: number;
  event_access: number;
  functions: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ContractStimulus =
  | { kind: 'construct' }
  | { kind: 'start'; promise_id: string }
  | { kind: 'welcome'; session_id: number; generation: number }
  | {
    kind: 'declaration_update';
    transaction: number;
    promise_ids: string[];
    changed_domains: DeclarationDomain[];
    revisions: DeclarationRevisions;
  }
  | { kind: 'declaration_handoff'; transaction: number }
  | { kind: 'declaration_ack'; domain: DeclarationDomain; transaction: number }
  | {
    kind: 'declaration_error';
    domain: DeclarationDomain;
    transaction: number;
    code: string;
  }
  | { kind: 'declaration_probe' }
  | { kind: 'disconnect'; phase: 'before_send' | 'sent' | 'accepted' | 'ready' }
  | {
    kind: 'operation';
    operation_id: string;
    operation: 'state_set' | 'event' | 'call';
    phase: 'before_send' | 'sent' | 'accepted';
    idempotency_key?: string | null;
  }
  | { kind: 'call_progress'; operation_id: string; value: JsonValue }
  | { kind: 'call_result'; operation_id: string; value: JsonValue }
  | { kind: 'call_cancel'; operation_id: string }
  | {
    kind: 'operation_terminal';
    operation_id: string;
    outcome: 'not_dispatched' | 'applied' | 'failed' | 'outcome_unknown';
  }
  | { kind: 'operation_error'; operation_id: string; code: string }
  | { kind: 'presence'; entries: PresenceTrace[] }
  | { kind: 'state_publish'; paths: string[] }
  | { kind: 'effect'; effect: string }
  | { kind: 'stop'; promise_id: string };

export interface ContractReplaySetup {
  scenario_id: string;
  mode: 'sdk' | 'observe' | 'shadow_state' | 'recorded_action';
  desired_declarations: DeclarationDomain[];
}

export interface PresenceTrace {
  session_id: number;
  user_id: string;
}

export interface LifecyclePromiseTrace {
  operation: 'start' | 'stop';
  promise_id: string;
  invocation_stimulus_index: number;
  settlement_stimulus_index: number;
  outcome: 'resolved' | 'rejected';
  code?: string;
  session_id?: number;
  generation?: number;
}

export interface DeclarationPromiseTrace {
  promise_id: string;
  transaction: number;
  stimulus_index: number;
  outcome: 'activated' | 'rejected';
  code?: string;
}

export interface OperationTrace {
  operation_id: string;
  operation: 'state_set' | 'event' | 'call';
  attempts: number;
  outcome: 'not_dispatched' | 'sent' | 'applied' | 'succeeded' | 'failed' | 'outcome_unknown';
  idempotency_key?: string | null;
}

export interface CallStreamTrace {
  operation_id: string;
  acceptance: 'resolved' | 'rejected';
  progress: JsonValue[];
  terminal:
    | { kind: 'result'; value: JsonValue }
    | { kind: 'error'; code: 'not_dispatched' | 'failed' | 'outcome_unknown' };
}

export interface ContractObservation {
  statuses: CoordinatorStatus[];
  status_checkpoints: Array<{ stimulus_index: number; status: CoordinatorStatus }>;
  lifecycle_promises: LifecyclePromiseTrace[];
  access_reasons: Array<'initial' | 'reauth' | 'reconnect'>;
  declarations: Array<{
    domain: DeclarationDomain;
    generation: number;
    transaction: number;
  }>;
  declaration_snapshots: Array<{
    generation: number;
    transaction: number;
    stimulus_index: number;
    revisions: DeclarationRevisions;
  }>;
  declaration_promises: DeclarationPromiseTrace[];
  declaration_visibility: Array<'none' | 'previous' | 'desired'>;
  operations: OperationTrace[];
  call_streams: CallStreamTrace[];
  presence: PresenceTrace[][];
  state_publications: number;
  effects: Array<{ effect: string; destination: 'recorder' | 'live' | 'rejected' }>;
  errors: Array<{
    code: string;
    stimulus_index: number;
    correlation?: { kind: 'event' | 'call'; local_id: string };
  }>;
  resources: {
    sockets: number;
    socket_high_water: number;
    timers: number | 'not_asserted';
    listeners: number | 'not_asserted';
    iterators: number | 'not_asserted';
  };
}

export interface ResourceObservation {
  sockets: number;
  socketHighWater: number;
  timers: number;
  terminal: boolean;
}

function errorCode(failure: CoordinatorFailure): string {
  return failure.kind;
}

export function terminalCode(failure: CoordinatorFailure): 'not_dispatched' | 'failed' | 'outcome_unknown' {
  if (failure.outcome === 'outcome_unknown') return 'outcome_unknown';
  if (failure.outcome === 'not_dispatched' && failure.kind !== 'internal') {
    return 'not_dispatched';
  }
  return 'failed';
}

export function operationOutcome(
  failure: CoordinatorFailure,
): 'not_dispatched' | 'failed' | 'outcome_unknown' {
  return terminalCode(failure);
}

export function isFailure(value: unknown): value is CoordinatorFailure {
  return value instanceof Error
    && 'kind' in value
    && 'outcome' in value
    && 'retryable' in value;
}

export class ContractRecorder {
  readonly statuses: CoordinatorStatus[] = [];
  readonly statusCheckpoints: Array<{ stimulus_index: number; status: CoordinatorStatus }> = [];
  readonly lifecyclePromises: LifecyclePromiseTrace[] = [];
  readonly accessReasons: Array<'initial' | 'reauth' | 'reconnect'> = [];
  readonly declarations: ContractObservation['declarations'] = [];
  readonly declarationSnapshots: ContractObservation['declaration_snapshots'] = [];
  readonly declarationPromises: DeclarationPromiseTrace[] = [];
  readonly declarationVisibility: Array<'none' | 'previous' | 'desired'> = [];
  readonly operations: OperationTrace[] = [];
  readonly callStreams: CallStreamTrace[] = [];
  readonly presence: PresenceTrace[][] = [];
  readonly effects: ContractObservation['effects'] = [];
  readonly errors: ContractObservation['errors'] = [];
  readonly #operationIdsByLocalId = new Map<string, string>();
  stimulusIndex = -1;
  statePublications = 0;
  recording = true;
  injectedErrorCode: string | undefined;

  recordInitialIdle(): void {
    this.statuses.push('idle');
    this.statusCheckpoints.push({ stimulus_index: this.stimulusIndex, status: 'idle' });
  }

  recordStatus(status: CoordinatorStatus): void {
    if (!this.recording) return;
    this.statuses.push(status);
    this.statusCheckpoints.push({ stimulus_index: this.stimulusIndex, status });
  }

  correlate(localId: string, operationId: string): void {
    this.#operationIdsByLocalId.set(localId, operationId);
  }

  recordFailure(failure: CoordinatorFailure): void {
    if (!this.recording) return;
    const code = this.injectedErrorCode ?? errorCode(failure);
    const correlation = failure.correlation;
    if (correlation === undefined) {
      this.errors.push({ code, stimulus_index: this.stimulusIndex });
      return;
    }
    const operationId = this.#operationIdsByLocalId.get(correlation.localId);
    if (operationId === undefined) {
      throw new Error('SDK emitted an error for an unknown local operation');
    }
    this.errors.push({
      code,
      stimulus_index: this.stimulusIndex,
      correlation: { kind: correlation.kind, local_id: operationId },
    });
  }

  observe(resources: ResourceObservation): ContractObservation {
    const unasserted = resources.terminal ? resources.timers : 'not_asserted';
    return {
      statuses: [...this.statuses],
      status_checkpoints: [...this.statusCheckpoints],
      lifecycle_promises: [...this.lifecyclePromises],
      access_reasons: [...this.accessReasons],
      declarations: [...this.declarations],
      declaration_snapshots: [...this.declarationSnapshots],
      declaration_promises: [...this.declarationPromises],
      declaration_visibility: [...this.declarationVisibility],
      operations: [...this.operations],
      call_streams: [...this.callStreams],
      presence: this.presence.map((entries) => entries.map((entry) => ({ ...entry }))),
      state_publications: this.statePublications,
      effects: [...this.effects],
      errors: [...this.errors],
      resources: {
        sockets: resources.sockets,
        socket_high_water: resources.socketHighWater,
        timers: unasserted,
        listeners: resources.terminal ? 0 : 'not_asserted',
        iterators: resources.terminal ? 0 : 'not_asserted',
      },
    };
  }
}

export function failureOutcome(value: unknown): DispatchOutcome | undefined {
  return isFailure(value) ? value.outcome : undefined;
}
