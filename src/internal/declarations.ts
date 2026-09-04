import type {
  CoordinatorAccess,
  CoordinatorConfiguration,
  DeclarationReceipt,
  EventDeclaration,
  FunctionHandler,
  ProtocolValue,
  UserEventAccess,
  UserStateAccess,
} from '../api.js';
import { LIMITS, Opcode, type Frame } from '../protocol/codec.js';
import {
  cancelled,
  invalidLifecycle,
  relayFailure,
  superseded,
  type CoordinatorError,
} from './errors.js';
import { createDeferred, type Deferred } from './resources.js';
import type { RelaySession } from './session.js';
import {
  validateDeclarationOptions,
  validateEventAccess,
  validateStateAccess,
} from './validation.js';

export type DeclarationDomain =
  | 'state'
  | 'state_access'
  | 'events'
  | 'event_access'
  | 'functions';

export const DECLARATION_DOMAINS: readonly DeclarationDomain[] = Object.freeze([
  'state',
  'state_access',
  'events',
  'event_access',
  'functions',
]);

interface DeclarationRevisions {
  state: number;
  state_access: number;
  events: number;
  event_access: number;
  functions: number;
}

export interface DeclarationSnapshot {
  state: Readonly<Record<string, ProtocolValue>>;
  stateAccess: readonly UserStateAccess[];
  events: readonly EventDeclaration[];
  eventAccess: readonly UserEventAccess[];
  functions: Readonly<Record<string, FunctionHandler>>;
  revisions: DeclarationRevisions;
}

export interface ActiveDeclarations {
  readonly snapshot: DeclarationSnapshot;
  readonly receipt: DeclarationReceipt;
  readonly stateIds: ReadonlyMap<string, number>;
  readonly topicIds: ReadonlyMap<string, number>;
  readonly functionIds: ReadonlyMap<string, number>;
}

export interface DeclarationHost {
  nextRequestId(): number;
  currentSession(): RelaySession | undefined;
  synchronizing(): void;
  activeDeclarationsChanged(active: ActiveDeclarations): void;
  declarationsReady(receipt: DeclarationReceipt): void;
  declarationFailure(
    failure: CoordinatorError,
    hasActiveConfiguration: boolean,
    hasQueuedSnapshot: boolean,
  ): void;
  transportFailure(error: unknown): void;
}

interface PendingDeclaration {
  domain: DeclarationDomain;
  revision: number;
  deferred: Deferred<DeclarationReceipt>;
  signal?: AbortSignal;
  abort?: () => void;
}

interface DeclarationTransaction {
  token: number;
  snapshot: DeclarationSnapshot;
  session: RelaySession;
  receipt: DeclarationReceipt;
  index: number;
  handedOff: boolean;
  stateIds: Map<string, number>;
  topicIds: Map<string, number>;
  functionIds: Map<string, number>;
}

interface DeclarationRequest {
  token: number;
  domain: DeclarationDomain;
}

const EMPTY_REVISIONS: DeclarationRevisions = Object.freeze({
  state: 0,
  state_access: 0,
  events: 0,
  event_access: 0,
  functions: 0,
});

function emptySnapshot(): DeclarationSnapshot {
  return Object.freeze({
    state: Object.freeze({}),
    stateAccess: Object.freeze([]),
    events: Object.freeze([]),
    eventAccess: Object.freeze([]),
    functions: Object.freeze({}),
    revisions: EMPTY_REVISIONS,
  });
}

function copyRevisions(value: DeclarationRevisions): DeclarationRevisions {
  return Object.freeze({ ...value });
}

function copySnapshot(value: DeclarationSnapshot): DeclarationSnapshot {
  return Object.freeze({
    state: value.state,
    stateAccess: value.stateAccess,
    events: value.events,
    eventAccess: value.eventAccess,
    functions: value.functions,
    revisions: copyRevisions(value.revisions),
  });
}

function revisionsEqual(left: DeclarationRevisions, right: DeclarationRevisions): boolean {
  return DECLARATION_DOMAINS.every((domain) => left[domain] === right[domain]);
}

function frameRequestId(frame: Frame): number | undefined {
  const value = frame.payload[0];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function dictionary(
  value: ProtocolValue | undefined,
  expectedNames: readonly string[],
): Map<string, number> {
  if (!Array.isArray(value)) throw new TypeError('Relay dictionary is not an array');
  const result = new Map<string, number>();
  const ids = new Set<number>();
  for (const raw of value) {
    if (!Array.isArray(raw)) throw new TypeError('Relay dictionary entry is not an array');
    const id = raw[0];
    const name = raw[1];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof name !== 'string') {
      throw new TypeError('Relay dictionary entry is invalid');
    }
    if (ids.has(id) || result.has(name)) throw new TypeError('Relay dictionary contains a duplicate');
    ids.add(id);
    result.set(name, id);
  }
  if (result.size !== expectedNames.length
    || expectedNames.some((name) => !result.has(name))) {
    throw new TypeError('Relay dictionary does not match the declared snapshot');
  }
  return result;
}

function ackDomain(opcode: number): DeclarationDomain | undefined {
  if (opcode === Opcode.StateSyncOk) return 'state';
  if (opcode === Opcode.StateAclOk) return 'state_access';
  if (opcode === Opcode.EventSyncOk) return 'events';
  if (opcode === Opcode.EventAclOk) return 'event_access';
  if (opcode === Opcode.FunctionSyncOk) return 'functions';
  return undefined;
}

export class DeclarationManager {
  readonly #host: DeclarationHost;
  readonly #pending: PendingDeclaration[] = [];
  readonly #requests = new Map<number, DeclarationRequest>();
  #desired = emptySnapshot();
  #active: ActiveDeclarations | undefined;
  #current: DeclarationTransaction | undefined;
  #transactionToken = 0;
  #stopped = false;

  constructor(host: DeclarationHost) {
    this.#host = host;
  }

  get desired(): DeclarationSnapshot {
    return this.#desired;
  }

  get active(): ActiveDeclarations | undefined {
    return this.#active;
  }

  configure(configuration: CoordinatorConfiguration): void {
    for (const domain of DECLARATION_DOMAINS) this.#supersedeUnprotected(domain);
    const revisions = {
      state: this.#desired.revisions.state + 1,
      state_access: this.#desired.revisions.state_access + 1,
      events: this.#desired.revisions.events + 1,
      event_access: this.#desired.revisions.event_access + 1,
      functions: this.#desired.revisions.functions + 1,
    };
    this.#desired = Object.freeze({
      ...configuration,
      revisions: Object.freeze(revisions),
    });
  }

  declareState(
    state: Readonly<Record<string, ProtocolValue>>,
    signal?: AbortSignal,
  ): Promise<DeclarationReceipt> {
    return this.#replace(
      'state',
      (snapshot, revisions) => copySnapshot({ ...snapshot, state, revisions }),
      signal,
    );
  }

  declareStateAccess(
    stateAccess: readonly UserStateAccess[],
    signal?: AbortSignal,
  ): Promise<DeclarationReceipt> {
    return this.#replace(
      'state_access',
      (snapshot, revisions) => copySnapshot({ ...snapshot, stateAccess, revisions }),
      signal,
    );
  }

  declareEvents(
    events: readonly EventDeclaration[],
    signal?: AbortSignal,
  ): Promise<DeclarationReceipt> {
    return this.#replace(
      'events',
      (snapshot, revisions) => copySnapshot({ ...snapshot, events, revisions }),
      signal,
    );
  }

  declareEventAccess(
    eventAccess: readonly UserEventAccess[],
    signal?: AbortSignal,
  ): Promise<DeclarationReceipt> {
    return this.#replace(
      'event_access',
      (snapshot, revisions) => copySnapshot({ ...snapshot, eventAccess, revisions }),
      signal,
    );
  }

  declareFunctions(
    functions: Readonly<Record<string, FunctionHandler>>,
    signal?: AbortSignal,
  ): Promise<DeclarationReceipt> {
    return this.#replace(
      'functions',
      (snapshot, revisions) => copySnapshot({ ...snapshot, functions, revisions }),
      signal,
    );
  }

  synchronize(session: RelaySession): void {
    this.#requests.clear();
    this.#current = undefined;
    this.#begin(session);
  }

  handleFrame(frame: Frame): boolean {
    const domain = ackDomain(frame.opcode);
    if (domain === undefined) return false;
    const requestId = frameRequestId(frame);
    if (requestId === undefined) throw new TypeError('Declaration acknowledgement has no request ID');
    const request = this.#requests.get(requestId);
    if (request === undefined) throw new TypeError('Declaration acknowledgement is not correlated');
    this.#requests.delete(requestId);
    const current = this.#current;
    if (current === undefined || request.token !== current.token) return true;
    const expectedDomain = DECLARATION_DOMAINS[current.index];
    if (request.domain !== domain || expectedDomain !== domain) {
      throw new TypeError('Declaration acknowledgement is out of order');
    }
    if (domain === 'state') {
      const epoch = frame.payload[1];
      const expectedEpoch = current.session.welcome.epoch;
      if (!(epoch instanceof Uint8Array)
        || epoch.length !== expectedEpoch.length
        || epoch.some((value, index) => value !== expectedEpoch[index])) {
        throw new TypeError('STATE_SYNC_OK uses a stale epoch');
      }
      current.stateIds = dictionary(frame.payload[3], Object.keys(current.snapshot.state));
    }
    if (domain === 'events') {
      current.topicIds = dictionary(
        frame.payload[1],
        current.snapshot.events.map(({ topic }) => topic),
      );
    }
    if (domain === 'functions') {
      current.functionIds = dictionary(frame.payload[1], Object.keys(current.snapshot.functions));
    }
    current.index += 1;
    if (current.index === DECLARATION_DOMAINS.length) this.#activate(current);
    else void this.#sendCurrentDomain(current);
    return true;
  }

  handleError(requestId: number, code: number, retryable: boolean): boolean {
    const request = this.#requests.get(requestId);
    if (request === undefined) return false;
    this.#requests.delete(requestId);
    const current = this.#current;
    if (current === undefined || request.token !== current.token) return true;
    if (retryable) {
      this.#host.transportFailure(relayFailure(code, true, 'not_dispatched'));
      return true;
    }
    this.#rejectTransaction(current, relayFailure(code, false, 'not_dispatched'));
    return true;
  }

  disconnected(): void {
    this.#requests.clear();
    this.#current = undefined;
  }

  stop(): void {
    this.#stopped = true;
    this.#requests.clear();
    this.#current = undefined;
    for (const pending of this.#pending.splice(0)) {
      this.#removePendingAbort(pending);
      pending.deferred.reject(cancelled('not_dispatched', 'Coordinator stopped before declaration activation'));
    }
  }

  #replace(
    domain: DeclarationDomain,
    update: (
      snapshot: DeclarationSnapshot,
      revisions: DeclarationRevisions,
    ) => DeclarationSnapshot,
    signal?: AbortSignal,
  ): Promise<DeclarationReceipt> {
    if (this.#stopped) return Promise.reject(invalidLifecycle('Coordinator is stopped'));
    if (signal?.aborted === true) return Promise.reject(cancelled('not_dispatched'));
    if (this.#pending.length >= LIMITS.declarationsPerCoordinator
      || this.#requests.size >= LIMITS.declarationsPerCoordinator) {
      return Promise.reject(new RangeError('Too many pending declarations'));
    }
    this.#supersedeUnprotected(domain);
    const revision = this.#desired.revisions[domain] + 1;
    const revisions = copyRevisions({ ...this.#desired.revisions, [domain]: revision });
    this.#desired = update(this.#desired, revisions);
    const deferred = createDeferred<DeclarationReceipt>();
    const pending: PendingDeclaration = { domain, revision, deferred };
    if (signal !== undefined) {
      const abort = () => {
        const index = this.#pending.indexOf(pending);
        if (index !== -1) this.#pending.splice(index, 1);
        deferred.reject(cancelled('not_dispatched'));
      };
      pending.signal = signal;
      pending.abort = abort;
      signal.addEventListener('abort', abort, { once: true });
    }
    this.#pending.push(pending);

    const session = this.#host.currentSession();
    if (session !== undefined) {
      if (this.#current === undefined) this.#begin(session);
      else if (!this.#current.handedOff) {
        this.#current = undefined;
        this.#begin(session);
      }
    }
    return deferred.promise;
  }

  #supersedeUnprotected(domain: DeclarationDomain): void {
    const protectedRevision = this.#current?.handedOff === true
      ? this.#current.snapshot.revisions[domain]
      : 0;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const pending = this.#pending[index];
      if (pending?.domain !== domain || pending.revision <= protectedRevision) continue;
      this.#pending.splice(index, 1);
      this.#removePendingAbort(pending);
      pending.deferred.reject(superseded());
    }
  }

  #begin(session: RelaySession): void {
    this.#transactionToken += 1;
    const welcome = session.welcome;
    this.#current = {
      token: this.#transactionToken,
      snapshot: copySnapshot(this.#desired),
      session,
      receipt: Object.freeze({
        sessionId: welcome.readySession.sessionId,
        generation: welcome.readySession.generation,
      }),
      index: 0,
      handedOff: false,
      stateIds: new Map(),
      topicIds: new Map(),
      functionIds: new Map(),
    };
    this.#host.synchronizing();
    if (this.#stopped) {
      this.#current = undefined;
      return;
    }
    void this.#sendCurrentDomain(this.#current);
  }

  async #sendCurrentDomain(transaction: DeclarationTransaction): Promise<void> {
    const domain = DECLARATION_DOMAINS[transaction.index];
    if (domain === undefined || this.#current?.token !== transaction.token) return;
    const requestId = this.#host.nextRequestId();
    this.#requests.set(requestId, { token: transaction.token, domain });
    const frame = this.#frameFor(transaction.snapshot, domain, requestId);
    if (domain === 'functions') transaction.handedOff = true;
    try {
      await transaction.session.send(frame);
    } catch (error) {
      if (this.#current?.token === transaction.token) this.#host.transportFailure(error);
    }
  }

  #frameFor(snapshot: DeclarationSnapshot, domain: DeclarationDomain, requestId: number): Frame {
    if (domain === 'state') {
      return {
        opcode: Opcode.StateSync,
        payload: [requestId, Object.entries(snapshot.state).map(([path, value]) => [path, value])],
      };
    }
    if (domain === 'state_access') {
      return {
        opcode: Opcode.StateAclSync,
        payload: [requestId, snapshot.stateAccess.map(({ userId, patterns }) => [
          userId,
          [...patterns],
        ])],
      };
    }
    if (domain === 'events') {
      return {
        opcode: Opcode.EventSync,
        payload: [requestId, snapshot.events.map(({ topic, directions }) => [topic, directions])],
      };
    }
    if (domain === 'event_access') {
      return {
        opcode: Opcode.EventAclSync,
        payload: [requestId, snapshot.eventAccess.map(({ userId, publish, subscribe }) => [
          userId,
          [...publish],
          [...subscribe],
        ])],
      };
    }
    return {
      opcode: Opcode.FunctionSync,
      payload: [requestId, Object.keys(snapshot.functions)],
    };
  }

  #activate(transaction: DeclarationTransaction): void {
    if (this.#current?.token !== transaction.token) return;
    this.#active = Object.freeze({
      snapshot: transaction.snapshot,
      receipt: transaction.receipt,
      stateIds: transaction.stateIds,
      topicIds: transaction.topicIds,
      functionIds: transaction.functionIds,
    });
    this.#current = undefined;
    this.#host.activeDeclarationsChanged(this.#active);
    this.#settleThrough(transaction.snapshot.revisions, transaction.receipt, undefined);
    if (!revisionsEqual(this.#desired.revisions, transaction.snapshot.revisions)) {
      this.#begin(transaction.session);
    } else {
      this.#host.declarationsReady(transaction.receipt);
    }
  }

  #rejectTransaction(transaction: DeclarationTransaction, failure: CoordinatorError): void {
    if (this.#current?.token !== transaction.token) return;
    this.#current = undefined;
    this.#settleThrough(transaction.snapshot.revisions, transaction.receipt, failure);
    const activeSnapshot = this.#active?.snapshot ?? emptySnapshot();
    const desired = this.#desired;
    const revisions = { ...desired.revisions };
    const next = {
      state: desired.state,
      stateAccess: desired.stateAccess,
      events: desired.events,
      eventAccess: desired.eventAccess,
      functions: desired.functions,
    };
    for (const domain of DECLARATION_DOMAINS) {
      if (desired.revisions[domain] > transaction.snapshot.revisions[domain]) continue;
      revisions[domain] = activeSnapshot.revisions[domain];
      if (domain === 'state') next.state = activeSnapshot.state;
      if (domain === 'state_access') next.stateAccess = activeSnapshot.stateAccess;
      if (domain === 'events') next.events = activeSnapshot.events;
      if (domain === 'event_access') next.eventAccess = activeSnapshot.eventAccess;
      if (domain === 'functions') next.functions = activeSnapshot.functions;
    }
    this.#desired = copySnapshot({ ...next, revisions: copyRevisions(revisions) });
    const hasQueuedSnapshot = !revisionsEqual(this.#desired.revisions, activeSnapshot.revisions);
    const hasActiveConfiguration = this.#active?.receipt.sessionId === transaction.receipt.sessionId
      && this.#active.receipt.generation === transaction.receipt.generation;
    this.#host.declarationFailure(failure, hasActiveConfiguration, hasQueuedSnapshot);
    if (hasQueuedSnapshot) {
      this.#begin(transaction.session);
    }
  }

  #settleThrough(
    revisions: DeclarationRevisions,
    receipt: DeclarationReceipt,
    failure: CoordinatorError | undefined,
  ): void {
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const pending = this.#pending[index];
      if (pending === undefined || pending.revision > revisions[pending.domain]) continue;
      this.#pending.splice(index, 1);
      this.#removePendingAbort(pending);
      if (failure === undefined) pending.deferred.resolve(receipt);
      else pending.deferred.reject(failure);
    }
  }

  #removePendingAbort(pending: PendingDeclaration): void {
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
  }
}

export class AccessManager implements CoordinatorAccess {
  readonly #declarations: DeclarationManager;

  constructor(declarations: DeclarationManager) {
    this.#declarations = declarations;
  }

  declareState(
    entries: readonly UserStateAccess[],
    options: import('../api.js').DeclarationOptions = {},
  ): Promise<DeclarationReceipt> {
    return this.#declarations.declareStateAccess(
      validateStateAccess(entries),
      validateDeclarationOptions(options, 'state access declaration'),
    );
  }

  declareEvents(
    entries: readonly UserEventAccess[],
    options: import('../api.js').DeclarationOptions = {},
  ): Promise<DeclarationReceipt> {
    return this.#declarations.declareEventAccess(
      validateEventAccess(entries),
      validateDeclarationOptions(options, 'event access declaration'),
    );
  }
}
