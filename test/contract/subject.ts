import type {
  AccessToken,
  AccessTokenRequest,
  CallHandle,
  Coordinator,
  DeclarationReceipt,
  EventHandle,
  ProtocolValue,
  StateReceipt,
} from '../../src/api.js';
import { EventDirection } from '../../src/api.js';
import { createCoordinatorWithRuntime } from '../../src/coordinator.js';
import { Opcode, type Frame } from '../../src/protocol/codec.js';
import { FakeRelay, type FakeRelayConnection } from '../fakes/relay.js';
import { FakeRuntime, flushMicrotasks } from '../fakes/runtime.js';
import {
  ContractRecorder,
  type CallStreamTrace,
  type ContractObservation,
  type ContractReplaySetup,
  type ContractStimulus,
  type DeclarationDomain,
  type DeclarationRevisions,
  type JsonValue,
  isFailure,
  operationOutcome,
} from './recorder.js';

const COORDINATOR_NAME = 'contract-coordinator';
const TOKEN_EXPIRY_MS = 8_000_000_000_000_000;
const DOMAIN_OPCODE: Record<DeclarationDomain, number> = {
  state: Opcode.StateSync,
  state_access: Opcode.StateAclSync,
  events: Opcode.EventSync,
  event_access: Opcode.EventAclSync,
  functions: Opcode.FunctionSync,
};

interface PendingToken {
  request: AccessTokenRequest;
  resolve(value: AccessToken): void;
  reject(reason: unknown): void;
  abort(): void;
}

interface TransactionSnapshot {
  generation: number;
  transaction: number;
  revisions: DeclarationRevisions;
}

interface OperationRecord {
  operationId: string;
  operation: 'state_set' | 'event' | 'call';
  trace: ContractObservation['operations'][number];
  wireId?: number;
  statePromise?: Promise<StateReceipt>;
  eventHandle?: EventHandle;
  callHandle?: CallHandle;
  callStream?: CallStreamTrace;
}

function cloneRevisions(revisions: DeclarationRevisions): DeclarationRevisions {
  return { ...revisions };
}

function revisionsEqual(left: DeclarationRevisions, right: DeclarationRevisions): boolean {
  return left.state === right.state
    && left.state_access === right.state_access
    && left.events === right.events
    && left.event_access === right.event_access
    && left.functions === right.functions;
}

function integer(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function array(value: ProtocolValue | undefined, label: string): ProtocolValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function dictionaryFromNames(names: readonly string[], firstId: number): ProtocolValue[] {
  return names.map((name, index) => [firstId + index, name]);
}

function namesFromTuples(value: ProtocolValue | undefined, label: string): string[] {
  return array(value, label).map((raw, index) => {
    const tuple = array(raw, `${label}[${index}]`);
    const name = tuple[0];
    if (typeof name !== 'string') throw new TypeError(`${label}[${index}] has no name`);
    return name;
  });
}

function names(value: ProtocolValue | undefined, label: string): string[] {
  return array(value, label).map((raw, index) => {
    if (typeof raw !== 'string') throw new TypeError(`${label}[${index}] is invalid`);
    return raw;
  });
}

function relayCode(code: string): number {
  if (code === 'authorization') return 1201;
  if (code === 'ownership_collision') return 1301;
  if (code === 'not_declared') return 1304;
  if (code === 'cancelled') return 1405;
  if (code === 'outcome_unknown') return 1404;
  if (code === 'application_failure') return 2_001;
  return 1500;
}

function sourceOpcode(domain: DeclarationDomain): number {
  return DOMAIN_OPCODE[domain];
}

class TokenGate {
  readonly #recorder: ContractRecorder;
  readonly #pending: PendingToken[] = [];

  constructor(recorder: ContractRecorder) {
    this.#recorder = recorder;
  }

  request(request: AccessTokenRequest): Promise<AccessToken> {
    this.#recorder.accessReasons.push(request.reason);
    return new Promise<AccessToken>((resolve, reject) => {
      const abort = () => {
        const index = this.#pending.indexOf(pending);
        if (index !== -1) this.#pending.splice(index, 1);
        reject(request.signal.reason);
      };
      const pending: PendingToken = {
        request,
        resolve: (value) => {
          request.signal.removeEventListener('abort', abort);
          resolve(value);
        },
        reject,
        abort,
      };
      if (request.signal.aborted) abort();
      else {
        this.#pending.push(pending);
        request.signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async releaseNext(): Promise<void> {
    for (let turn = 0; turn < 20 && this.#pending.length === 0; turn += 1) {
      await flushMicrotasks(1);
    }
    const pending = this.#pending.shift();
    if (pending === undefined) throw new Error('SDK did not request an access token');
    pending.resolve({
      relayUrl: 'wss://relay.contract.test/miakapp/ws',
      token: `contract-${pending.request.reason}`,
      expiresAtMs: TOKEN_EXPIRY_MS,
    });
  }
}

class CoordinatorSdkContractSubject {
  #setup: ContractReplaySetup | undefined;
  #recorder = new ContractRecorder();
  #relay: FakeRelay | undefined;
  #runtime: FakeRuntime | undefined;
  #tokenGate: TokenGate | undefined;
  #coordinator: Coordinator | undefined;
  #connection: FakeRelayConnection | undefined;
  #connectionIndex = 0;
  #generation = 0;
  #stimulusIndex = -1;
  #desiredRevisions: DeclarationRevisions = {
    state: 0,
    state_access: 0,
    events: 0,
    event_access: 0,
    functions: 0,
  };
  #activeRevisions: DeclarationRevisions | undefined;
  readonly #transactions = new Map<string, TransactionSnapshot>();
  readonly #functionFrames = new Map<string, Frame>();
  readonly #operations = new Map<string, OperationRecord>();
  readonly #declarationPromiseOrder = new Map<string, number>();
  readonly #background: Promise<void>[] = [];
  #primaryStartCount = 0;
  #stopSettlementIndex: number | undefined;
  #presenceInitial = true;
  #currentTransaction: number | undefined;
  #queuedTransaction: number | undefined;
  #transactionHandedOff = false;

  async reset(setup: ContractReplaySetup, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    await this.#cleanupPrevious();
    this.#setup = setup;
    this.#recorder = new ContractRecorder();
    this.#relay = undefined;
    this.#runtime = undefined;
    this.#tokenGate = undefined;
    this.#coordinator = undefined;
    this.#connection = undefined;
    this.#connectionIndex = 0;
    this.#generation = 0;
    this.#stimulusIndex = -1;
    this.#desiredRevisions = {
      state: 0,
      state_access: 0,
      events: 0,
      event_access: 0,
      functions: 0,
    };
    this.#activeRevisions = undefined;
    this.#transactions.clear();
    this.#functionFrames.clear();
    this.#operations.clear();
    this.#declarationPromiseOrder.clear();
    this.#background.length = 0;
    this.#primaryStartCount = 0;
    this.#stopSettlementIndex = undefined;
    this.#presenceInitial = true;
    this.#currentTransaction = undefined;
    this.#queuedTransaction = undefined;
    this.#transactionHandedOff = false;
  }

  async dispatch(stimulus: ContractStimulus, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.#stimulusIndex += 1;
    this.#recorder.stimulusIndex = this.#stimulusIndex;
    switch (stimulus.kind) {
      case 'construct':
        this.#ensureCoordinator(true);
        break;
      case 'start':
        this.#start(stimulus.promise_id);
        break;
      case 'welcome':
        await this.#welcome(stimulus.session_id, stimulus.generation);
        break;
      case 'declaration_update':
        this.#declarationUpdate(stimulus);
        break;
      case 'declaration_handoff':
        await this.#declarationHandoff(stimulus.transaction);
        break;
      case 'declaration_ack':
        await this.#declarationAck(stimulus.domain, stimulus.transaction);
        break;
      case 'declaration_error':
        await this.#declarationError(stimulus.domain, stimulus.transaction, stimulus.code);
        break;
      case 'declaration_probe':
        this.#declarationProbe();
        break;
      case 'operation':
        await this.#operation(stimulus);
        break;
      case 'operation_terminal':
        await this.#operationTerminal(stimulus.operation_id, stimulus.outcome);
        break;
      case 'operation_error':
        await this.#operationError(stimulus.operation_id, stimulus.code);
        break;
      case 'call_progress':
        await this.#callProgress(stimulus.operation_id, stimulus.value);
        break;
      case 'call_result':
        await this.#callResult(stimulus.operation_id, stimulus.value);
        break;
      case 'call_cancel':
        await this.#callCancel(stimulus.operation_id);
        break;
      case 'disconnect':
        this.#connectionOrThrow().close();
        this.#currentTransaction = undefined;
        this.#queuedTransaction = undefined;
        this.#transactionHandedOff = false;
        break;
      case 'presence':
        this.#presence(stimulus.entries);
        break;
      case 'stop':
        await this.#stop(stimulus.promise_id);
        break;
      case 'state_publish':
      case 'effect':
        throw new Error(`SDK contract subject cannot dispatch migration stimulus ${stimulus.kind}`);
      default:
        throw new Error('Unsupported coordinator contract stimulus');
    }
    await flushMicrotasks(20);
  }

  async observe(signal: AbortSignal): Promise<ContractObservation> {
    if (signal.aborted) throw signal.reason;
    await flushMicrotasks(30);
    await Promise.all(this.#background);
    if (signal.aborted) throw signal.reason;
    this.#recorder.lifecyclePromises.sort((left, right) => (
      left.invocation_stimulus_index - right.invocation_stimulus_index
    ));
    this.#recorder.declarationPromises.sort((left, right) => (
      (this.#declarationPromiseOrder.get(left.promise_id) ?? Number.MAX_SAFE_INTEGER)
      - (this.#declarationPromiseOrder.get(right.promise_id) ?? Number.MAX_SAFE_INTEGER)
    ));
    const coordinator = this.#coordinator;
    const relay = this.#relay;
    const runtime = this.#runtime;
    const terminal = coordinator === undefined
      || coordinator.status === 'idle'
      || coordinator.status === 'stopped';
    return this.#recorder.observe({
      sockets: relay?.openConnectionCount ?? 0,
      socketHighWater: relay?.socketHighWater ?? 0,
      timers: runtime?.pendingTimerCount ?? 0,
      terminal,
    });
  }

  async #cleanupPrevious(): Promise<void> {
    const coordinator = this.#coordinator;
    if (coordinator === undefined || coordinator.status === 'stopped') return;
    this.#recorder.recording = false;
    const stopped = coordinator.stop({ deadlineMs: 0 });
    await this.#runtime?.advanceBy(0);
    await stopped;
  }

  #ensureCoordinator(recordIdle = false): Coordinator {
    if (this.#coordinator !== undefined) return this.#coordinator;
    if (this.#setup === undefined || this.#setup.mode !== 'sdk') {
      throw new Error('SDK subject requires an sdk setup');
    }
    const relay = new FakeRelay({ autoWelcome: false, coordinatorName: COORDINATOR_NAME });
    const runtime = new FakeRuntime(relay);
    const tokenGate = new TokenGate(this.#recorder);
    const coordinator = createCoordinatorWithRuntime({
      name: COORDINATOR_NAME,
      accessTokenProvider: {
        getAccessToken: (request) => tokenGate.request(request),
      },
    }, runtime);
    coordinator.configure(this.#configurationFor(this.#desiredRevisions));
    coordinator.subscribe((event) => this.#recorder.recordStatus(event.current));
    coordinator.errors.subscribe((failure) => this.#recorder.recordFailure(failure));
    coordinator.presence.subscribe((entries) => {
      if (this.#presenceInitial) {
        this.#presenceInitial = false;
        return;
      }
      if (!this.#recorder.recording) return;
      this.#recorder.presence.push(entries.map((entry) => ({
        session_id: entry.sessionId,
        user_id: entry.userId,
      })));
    });
    this.#relay = relay;
    this.#runtime = runtime;
    this.#tokenGate = tokenGate;
    this.#coordinator = coordinator;
    if (recordIdle) this.#recorder.recordInitialIdle();
    return coordinator;
  }

  #configurationFor(revisions: DeclarationRevisions) {
    return {
      state: this.#stateFor(revisions.state),
      stateAccess: this.#stateAccessFor(revisions.state_access),
      events: this.#eventsFor(revisions.events),
      eventAccess: this.#eventAccessFor(revisions.event_access),
      functions: this.#functionsFor(revisions.functions),
    };
  }

  #stateFor(revision: number): Readonly<Record<string, ProtocolValue>> {
    return { 'contract.state': revision };
  }

  #stateAccessFor(revision: number) {
    return [{ userId: `contract-user-${revision}`, patterns: ['contract.*'] }];
  }

  #eventsFor(revision: number) {
    const entries = [{ topic: 'contract.event', directions: EventDirection.publishToUsers }];
    if (revision > 0) {
      entries.push({
        topic: `contract.event.revision${revision}`,
        directions: EventDirection.publishToUsers,
      });
    }
    return entries;
  }

  #eventAccessFor(revision: number) {
    return [{
      userId: `contract-user-${revision}`,
      publish: ['contract.*'],
      subscribe: ['contract.*'],
    }];
  }

  #functionsFor(revision: number) {
    const functions: Record<string, () => ProtocolValue> = {
      'contract.call': () => revision,
    };
    if (revision > 0) functions[`contract.call.revision${revision}`] = () => revision;
    return functions;
  }

  #start(promiseId: string): void {
    const coordinator = this.#ensureCoordinator();
    const invocationIndex = this.#stimulusIndex;
    const duplicate = this.#primaryStartCount > 0;
    this.#primaryStartCount += 1;
    const started = coordinator.start();
    const tracked = started.then(
      (ready) => {
        this.#recorder.lifecyclePromises.push({
          operation: 'start',
          promise_id: promiseId,
          invocation_stimulus_index: invocationIndex,
          settlement_stimulus_index: this.#recorder.stimulusIndex,
          outcome: 'resolved',
          session_id: ready.sessionId,
          generation: ready.generation,
        });
      },
      (error: unknown) => {
        if (!isFailure(error)) throw error;
        this.#recorder.lifecyclePromises.push({
          operation: 'start',
          promise_id: promiseId,
          invocation_stimulus_index: invocationIndex,
          settlement_stimulus_index: this.#recorder.stimulusIndex,
          outcome: 'rejected',
          code: error.kind,
        });
        if (duplicate) this.#recorder.recordFailure(error);
      },
    );
    this.#background.push(tracked);
  }

  async #welcome(sessionId: number, generation: number): Promise<void> {
    const coordinator = this.#ensureCoordinator();
    const runtime = this.#runtimeOrThrow();
    if (coordinator.status === 'reconnecting') await runtime.advanceBy(0);
    await this.#tokenGateOrThrow().releaseNext();
    await flushMicrotasks(20);
    const connection = await this.#relayOrThrow().connectionAt(this.#connectionIndex);
    this.#connectionIndex += 1;
    await connection.nextClientFrame(Opcode.Hello);
    connection.send({
      opcode: Opcode.Welcome,
      payload: [
        1,
        0,
        sessionId,
        connection.epoch,
        true,
        [[COORDINATOR_NAME, generation, 1]],
        [262_144, 128, 256, 1_048_576],
        TOKEN_EXPIRY_MS,
      ],
    });
    this.#connection = connection;
    this.#generation = generation;
    const snapshot: TransactionSnapshot = {
      generation,
      transaction: 1,
      revisions: cloneRevisions(this.#desiredRevisions),
    };
    this.#transactions.set(this.#transactionKey(generation, 1), snapshot);
    this.#currentTransaction = 1;
    this.#queuedTransaction = undefined;
    this.#transactionHandedOff = false;
    this.#recordTransactionStart(snapshot);
    await flushMicrotasks(20);
  }

  #declarationUpdate(
    stimulus: Extract<ContractStimulus, { kind: 'declaration_update' }>,
  ): void {
    const coordinator = this.#ensureCoordinator();
    if (stimulus.changed_domains.length !== stimulus.promise_ids.length) {
      throw new Error('Declaration promise IDs do not match changed domains');
    }
    this.#desiredRevisions = cloneRevisions(stimulus.revisions);
    const snapshot: TransactionSnapshot = {
      generation: this.#generation,
      transaction: stimulus.transaction,
      revisions: cloneRevisions(stimulus.revisions),
    };
    this.#transactions.set(this.#transactionKey(this.#generation, stimulus.transaction), snapshot);
    if (this.#currentTransaction === undefined) {
      this.#currentTransaction = stimulus.transaction;
      this.#transactionHandedOff = false;
      this.#recordTransactionStart(snapshot);
    } else if (this.#transactionHandedOff) {
      this.#queuedTransaction = stimulus.transaction;
    } else {
      this.#currentTransaction = stimulus.transaction;
      this.#recordTransactionStart(snapshot);
    }

    stimulus.changed_domains.forEach((domain, index) => {
      const promiseId = stimulus.promise_ids[index];
      if (promiseId === undefined) throw new Error('Declaration promise ID is missing');
      this.#declarationPromiseOrder.set(promiseId, this.#declarationPromiseOrder.size);
      let declaration: Promise<DeclarationReceipt>;
      if (domain === 'state') {
        declaration = coordinator.state.declare(this.#stateFor(stimulus.revisions.state));
      } else if (domain === 'state_access') {
        declaration = coordinator.access.declareState(
          this.#stateAccessFor(stimulus.revisions.state_access),
        );
      } else if (domain === 'events') {
        declaration = coordinator.events.declare(this.#eventsFor(stimulus.revisions.events));
      } else if (domain === 'event_access') {
        declaration = coordinator.access.declareEvents(
          this.#eventAccessFor(stimulus.revisions.event_access),
        );
      } else {
        declaration = coordinator.functions.declare(
          this.#functionsFor(stimulus.revisions.functions),
        );
      }
      const tracked = declaration.then(
        () => {
          this.#recorder.declarationPromises.push({
            promise_id: promiseId,
            transaction: stimulus.transaction,
            stimulus_index: this.#recorder.stimulusIndex,
            outcome: 'activated',
          });
        },
        (error: unknown) => {
          if (!isFailure(error)) throw error;
          this.#recorder.declarationPromises.push({
            promise_id: promiseId,
            transaction: stimulus.transaction,
            stimulus_index: this.#recorder.stimulusIndex,
            outcome: 'rejected',
            code: this.#recorder.injectedErrorCode ?? error.kind,
          });
        },
      );
      this.#background.push(tracked);
    });
  }

  async #declarationHandoff(transaction: number): Promise<void> {
    if (this.#currentTransaction !== transaction) {
      throw new Error(`Declaration transaction ${transaction} is not current at handoff`);
    }
    const frame = await this.#takeLatestOpcode(Opcode.FunctionSync);
    this.#verifyDeclarationFrame('functions', transaction, frame);
    this.#functionFrames.set(this.#transactionKey(this.#generation, transaction), frame);
    this.#transactionHandedOff = true;
  }

  async #declarationAck(domain: DeclarationDomain, transaction: number): Promise<void> {
    const key = this.#transactionKey(this.#generation, transaction);
    const frame = domain === 'functions'
      ? this.#functionFrames.get(key)
      : await this.#takeLatestOpcode(DOMAIN_OPCODE[domain]);
    if (frame === undefined) throw new Error(`Missing ${domain} declaration handoff`);
    this.#verifyDeclarationFrame(domain, transaction, frame);
    const requestId = integer(frame.payload[0], `${domain} request ID`);
    const connection = this.#connectionOrThrow();
    if (domain === 'state') {
      connection.send({
        opcode: Opcode.StateSyncOk,
        payload: [
          requestId,
          connection.epoch,
          transaction + 1,
          dictionaryFromNames(namesFromTuples(frame.payload[1], 'STATE_SYNC.entries'), 101),
        ],
      });
    } else if (domain === 'state_access') {
      connection.send({ opcode: Opcode.StateAclOk, payload: [requestId, transaction + 1] });
    } else if (domain === 'events') {
      connection.send({
        opcode: Opcode.EventSyncOk,
        payload: [
          requestId,
          dictionaryFromNames(namesFromTuples(frame.payload[1], 'EVENT_SYNC.entries'), 201),
        ],
      });
    } else if (domain === 'event_access') {
      connection.send({ opcode: Opcode.EventAclOk, payload: [requestId, transaction + 1] });
    } else {
      connection.send({
        opcode: Opcode.FunctionSyncOk,
        payload: [requestId, dictionaryFromNames(names(frame.payload[1], 'FUNCTION_SYNC.names'), 301)],
      });
      this.#functionFrames.delete(key);
      const snapshot = this.#transaction(transaction);
      this.#activeRevisions = cloneRevisions(snapshot.revisions);
      this.#activateQueuedTransaction();
    }
    this.#recorder.declarations.push({ domain, generation: this.#generation, transaction });
    await flushMicrotasks(20);
  }

  async #declarationError(
    domain: DeclarationDomain,
    transaction: number,
    code: string,
  ): Promise<void> {
    const key = this.#transactionKey(this.#generation, transaction);
    const frame = domain === 'functions'
      ? this.#functionFrames.get(key)
      : await this.#takeLatestOpcode(DOMAIN_OPCODE[domain]);
    if (frame === undefined) throw new Error(`Missing ${domain} declaration frame`);
    this.#verifyDeclarationFrame(domain, transaction, frame);
    this.#recorder.injectedErrorCode = code;
    this.#connectionOrThrow().send({
      opcode: Opcode.Error,
      payload: [
        integer(frame.payload[0], `${domain} request ID`),
        sourceOpcode(domain),
        relayCode(code),
        false,
        'Synthetic declaration rejection',
      ],
    });
    await flushMicrotasks(20);
    this.#recorder.injectedErrorCode = undefined;
    if (this.#activeRevisions !== undefined) {
      this.#desiredRevisions = cloneRevisions(this.#activeRevisions);
    }
    this.#activateQueuedTransaction();
  }

  #activateQueuedTransaction(): void {
    if (this.#queuedTransaction === undefined) {
      this.#currentTransaction = undefined;
      this.#transactionHandedOff = false;
      return;
    }
    this.#currentTransaction = this.#queuedTransaction;
    this.#queuedTransaction = undefined;
    this.#transactionHandedOff = false;
    this.#recordTransactionStart(this.#transaction(this.#currentTransaction));
  }

  #recordTransactionStart(snapshot: TransactionSnapshot): void {
    if (this.#recorder.declarationSnapshots.some((entry) => (
      entry.generation === snapshot.generation && entry.transaction === snapshot.transaction
    ))) return;
    this.#recorder.declarationSnapshots.push({
      generation: snapshot.generation,
      transaction: snapshot.transaction,
      stimulus_index: this.#stimulusIndex,
      revisions: cloneRevisions(snapshot.revisions),
    });
  }

  #declarationProbe(): void {
    if (this.#activeRevisions === undefined) {
      this.#recorder.declarationVisibility.push('none');
    } else if (revisionsEqual(this.#activeRevisions, this.#desiredRevisions)) {
      this.#recorder.declarationVisibility.push('desired');
    } else {
      this.#recorder.declarationVisibility.push('previous');
    }
  }

  async #operation(
    stimulus: Extract<ContractStimulus, { kind: 'operation' }>,
  ): Promise<void> {
    const coordinator = this.#ensureCoordinator();
    const trace: ContractObservation['operations'][number] = stimulus.operation === 'call'
      ? {
        operation_id: stimulus.operation_id,
        operation: stimulus.operation,
        attempts: 0,
        outcome: 'not_dispatched',
        idempotency_key: stimulus.idempotency_key ?? null,
      }
      : {
        operation_id: stimulus.operation_id,
        operation: stimulus.operation,
        attempts: 0,
        outcome: 'not_dispatched',
      };
    const record: OperationRecord = {
      operationId: stimulus.operation_id,
      operation: stimulus.operation,
      trace,
    };
    this.#operations.set(stimulus.operation_id, record);
    this.#recorder.operations.push(trace);

    if (stimulus.operation === 'state_set') {
      const operation = coordinator.state.set([
        { path: 'contract.state', value: this.#stimulusIndex },
      ]);
      record.statePromise = operation;
      this.#trackStateOperation(record, operation);
      if (stimulus.phase !== 'before_send') {
        const frame = await this.#takeLatestOpcode(Opcode.StateSet);
        record.wireId = integer(frame.payload[0], 'STATE_SET.requestId');
        trace.attempts += 1;
      }
      return;
    }
    if (stimulus.operation === 'event') {
      const handle = coordinator.events.publish('contract.event', stimulus.operation_id);
      record.eventHandle = handle;
      this.#recorder.correlate(handle.localId, stimulus.operation_id);
      const tracked = handle.sent.then(
        () => { trace.outcome = 'sent'; },
        (error: unknown) => {
          if (!isFailure(error)) throw error;
          trace.outcome = operationOutcome(error);
        },
      );
      this.#background.push(tracked);
      if (stimulus.phase !== 'before_send') {
        const frame = await this.#takeLatestOpcode(Opcode.Event);
        record.wireId = integer(frame.payload[0], 'EVENT.eventId');
        trace.attempts += 1;
      }
      return;
    }

    const callBase = {
      function: 'contract.call',
      arguments: stimulus.operation_id,
      timeoutMs: 300_000,
    };
    const options = stimulus.idempotency_key === undefined || stimulus.idempotency_key === null
      ? callBase
      : { ...callBase, idempotencyKey: stimulus.idempotency_key };
    const handle = coordinator.calls.start(options);
    record.callHandle = handle;
    this.#recorder.correlate(handle.localId, stimulus.operation_id);
    const callStream: CallStreamTrace = {
      operation_id: stimulus.operation_id,
      acceptance: 'rejected',
      progress: [],
      terminal: { kind: 'error', code: 'not_dispatched' },
    };
    record.callStream = callStream;
    this.#recorder.callStreams.push(callStream);
    this.#trackCallOperation(record, handle, callStream);
    if (stimulus.phase !== 'before_send') {
      const frame = await this.#takeLatestOpcode(Opcode.Call);
      record.wireId = integer(frame.payload[0], 'CALL.callId');
      trace.attempts += 1;
      if (stimulus.phase === 'accepted') {
        this.#connectionOrThrow().send({ opcode: Opcode.CallAccepted, payload: [record.wireId] });
      }
    }
  }

  #trackStateOperation(record: OperationRecord, operation: Promise<StateReceipt>): void {
    const tracked = operation.then(
      () => { record.trace.outcome = 'applied'; },
      (error: unknown) => {
        if (!isFailure(error)) throw error;
        record.trace.outcome = operationOutcome(error);
      },
    );
    this.#background.push(tracked);
  }

  #trackCallOperation(
    record: OperationRecord,
    handle: CallHandle,
    stream: CallStreamTrace,
  ): void {
    const acceptance = handle.accepted.then(
      () => { stream.acceptance = 'resolved'; },
      (error: unknown) => {
        if (!isFailure(error)) throw error;
        stream.acceptance = 'rejected';
      },
    );
    const result = handle.result.then(
      (value) => {
        const json = this.#jsonValue(value);
        record.trace.outcome = 'succeeded';
        stream.terminal = { kind: 'result', value: json };
      },
      (error: unknown) => {
        if (!isFailure(error)) throw error;
        const outcome = operationOutcome(error);
        record.trace.outcome = outcome;
        stream.terminal = { kind: 'error', code: outcome };
      },
    );
    const progress = (async () => {
      try {
        for await (const value of handle.stream) stream.progress.push(this.#jsonValue(value));
      } catch (error) {
        if (!isFailure(error)) throw error;
      }
    })();
    this.#background.push(acceptance, result, progress);
  }

  async #operationTerminal(
    operationId: string,
    outcome: 'not_dispatched' | 'applied' | 'failed' | 'outcome_unknown',
  ): Promise<void> {
    const operation = this.#operationOrThrow(operationId);
    if (operation.operation === 'state_set' && operation.wireId !== undefined) {
      if (outcome === 'applied') {
        this.#connectionOrThrow().send({
          opcode: Opcode.StateSetOk,
          payload: [operation.wireId, this.#connectionOrThrow().epoch, this.#stimulusIndex + 1],
        });
      } else if (outcome === 'failed' || outcome === 'not_dispatched') {
        this.#connectionOrThrow().send({
          opcode: Opcode.Error,
          payload: [
            operation.wireId,
            Opcode.StateSet,
            outcome === 'failed' ? 1500 : 1304,
            false,
            'Synthetic state terminal',
          ],
        });
      }
    }
    await flushMicrotasks(20);
    if (operation.trace.outcome !== outcome) {
      throw new Error(
        `SDK operation ${operationId} settled ${operation.trace.outcome}, expected ${outcome}`,
      );
    }
  }

  async #operationError(operationId: string, code: string): Promise<void> {
    const operation = this.#operationOrThrow(operationId);
    if (operation.wireId === undefined) throw new Error(`Operation ${operationId} has no wire ID`);
    this.#recorder.injectedErrorCode = code;
    if (operation.operation === 'event') {
      this.#connectionOrThrow().send({
        opcode: Opcode.Error,
        payload: [operation.wireId, Opcode.Event, relayCode(code), false, 'Synthetic event error'],
      });
    } else if (operation.operation === 'call') {
      this.#connectionOrThrow().send({
        opcode: Opcode.CallError,
        payload: [operation.wireId, relayCode(code), false, 'Synthetic call error', null],
      });
    } else {
      throw new Error('State errors use operation_terminal stimuli');
    }
    await flushMicrotasks(20);
    this.#recorder.injectedErrorCode = undefined;
  }

  async #callProgress(operationId: string, value: JsonValue): Promise<void> {
    const operation = this.#operationOrThrow(operationId);
    if (operation.operation !== 'call' || operation.wireId === undefined) {
      throw new Error(`Operation ${operationId} is not an active call`);
    }
    this.#connectionOrThrow().send({
      opcode: Opcode.CallResult,
      payload: [operation.wireId, false, value],
    });
    await flushMicrotasks(20);
    await this.#takeLatestOpcode(Opcode.CallCredit);
  }

  async #callResult(operationId: string, value: JsonValue): Promise<void> {
    const operation = this.#operationOrThrow(operationId);
    if (operation.operation !== 'call' || operation.wireId === undefined) {
      throw new Error(`Operation ${operationId} is not an active call`);
    }
    this.#connectionOrThrow().send({
      opcode: Opcode.CallResult,
      payload: [operation.wireId, true, value],
    });
  }

  async #callCancel(operationId: string): Promise<void> {
    const operation = this.#operationOrThrow(operationId);
    if (operation.callHandle === undefined || operation.wireId === undefined) {
      throw new Error(`Operation ${operationId} is not an active call`);
    }
    operation.callHandle.cancel();
    const frame = await this.#takeLatestOpcode(Opcode.CallCancel);
    if (integer(frame.payload[0], 'CALL_CANCEL.callId') !== operation.wireId) {
      throw new Error('SDK cancelled the wrong call');
    }
  }

  #presence(entries: Array<{ session_id: number; user_id: string }>): void {
    this.#connectionOrThrow().send({
      opcode: Opcode.PresenceSnapshot,
      payload: [entries.map((entry) => [entry.session_id, entry.user_id])],
    });
  }

  async #stop(promiseId: string): Promise<void> {
    const coordinator = this.#ensureCoordinator();
    const invocationIndex = this.#stimulusIndex;
    const stopped = coordinator.stop();
    await stopped;
    if (this.#stopSettlementIndex === undefined) this.#stopSettlementIndex = this.#stimulusIndex;
    this.#recorder.lifecyclePromises.push({
      operation: 'stop',
      promise_id: promiseId,
      invocation_stimulus_index: invocationIndex,
      settlement_stimulus_index: this.#stopSettlementIndex,
      outcome: 'resolved',
    });
  }

  async #takeLatestOpcode(opcode: number): Promise<Frame> {
    const connection = this.#connectionOrThrow();
    await flushMicrotasks(20);
    const frames: Frame[] = [];
    if (connection.queuedClientFrameCount === 0) {
      frames.push(await connection.nextClientFrame());
    }
    while (connection.queuedClientFrameCount > 0) {
      frames.push(await connection.nextClientFrame());
    }
    const matching = frames.filter((frame) => frame.opcode === opcode);
    const selected = matching[matching.length - 1];
    if (selected === undefined) {
      throw new Error(
        `SDK did not emit opcode 0x${opcode.toString(16)}; received ${frames.map((frame) => frame.opcode).join(',')}`,
      );
    }
    return selected;
  }

  #verifyDeclarationFrame(domain: DeclarationDomain, transaction: number, frame: Frame): void {
    const snapshot = this.#transaction(transaction);
    if (frame.opcode !== DOMAIN_OPCODE[domain]) throw new Error(`Wrong frame for ${domain}`);
    if (domain === 'state') {
      const entries = array(frame.payload[1], 'STATE_SYNC.entries');
      const base = entries.find((entry) => Array.isArray(entry) && entry[0] === 'contract.state');
      if (!Array.isArray(base) || base[1] !== snapshot.revisions.state) {
        throw new Error('STATE_SYNC does not contain the expected desired revision');
      }
    }
    if (domain === 'state_access') {
      const entries = array(frame.payload[1], 'STATE_ACL_SYNC.entries');
      const first = entries[0];
      if (!Array.isArray(first) || first[0] !== `contract-user-${snapshot.revisions.state_access}`) {
        throw new Error('STATE_ACL_SYNC does not contain the expected desired revision');
      }
    }
    if (domain === 'events') {
      const eventNames = namesFromTuples(frame.payload[1], 'EVENT_SYNC.entries');
      const marker = snapshot.revisions.events === 0
        ? 'contract.event'
        : `contract.event.revision${snapshot.revisions.events}`;
      if (!eventNames.includes(marker)) {
        throw new Error('EVENT_SYNC does not contain the expected desired revision');
      }
    }
    if (domain === 'event_access') {
      const entries = array(frame.payload[1], 'EVENT_ACL_SYNC.entries');
      const first = entries[0];
      if (!Array.isArray(first) || first[0] !== `contract-user-${snapshot.revisions.event_access}`) {
        throw new Error('EVENT_ACL_SYNC does not contain the expected desired revision');
      }
    }
    if (domain === 'functions') {
      const functionNames = names(frame.payload[1], 'FUNCTION_SYNC.names');
      const marker = snapshot.revisions.functions === 0
        ? 'contract.call'
        : `contract.call.revision${snapshot.revisions.functions}`;
      if (!functionNames.includes(marker)) {
        throw new Error('FUNCTION_SYNC does not contain the expected desired revision');
      }
    }
  }

  #transaction(transaction: number): TransactionSnapshot {
    const snapshot = this.#transactions.get(this.#transactionKey(this.#generation, transaction));
    if (snapshot === undefined) throw new Error(`Unknown declaration transaction ${transaction}`);
    return snapshot;
  }

  #transactionKey(generation: number, transaction: number): string {
    return `${generation}:${transaction}`;
  }

  #operationOrThrow(operationId: string): OperationRecord {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) throw new Error(`Unknown operation ${operationId}`);
    return operation;
  }

  #connectionOrThrow(): FakeRelayConnection {
    if (this.#connection === undefined) throw new Error('No active contract relay connection');
    return this.#connection;
  }

  #runtimeOrThrow(): FakeRuntime {
    if (this.#runtime === undefined) throw new Error('Contract runtime is not constructed');
    return this.#runtime;
  }

  #relayOrThrow(): FakeRelay {
    if (this.#relay === undefined) throw new Error('Contract relay is not constructed');
    return this.#relay;
  }

  #tokenGateOrThrow(): TokenGate {
    if (this.#tokenGate === undefined) throw new Error('Contract token gate is not constructed');
    return this.#tokenGate;
  }

  #jsonValue(value: ProtocolValue): JsonValue {
    if (value instanceof Uint8Array) throw new TypeError('Contract JSON trace cannot contain binary');
    if (Array.isArray(value)) return value.map((entry) => this.#jsonValue(entry));
    if (value !== null && typeof value === 'object') {
      const output: { [key: string]: JsonValue } = {};
      for (const [key, entry] of Object.entries(value)) output[key] = this.#jsonValue(entry);
      return output;
    }
    return value;
  }
}

export function createCoordinatorContractSubject(): CoordinatorSdkContractSubject {
  return new CoordinatorSdkContractSubject();
}
