import type {
  BrowserState,
  BrowserStateSnapshot,
} from '../browser-api.js';
import type { ProtocolValue } from '../api.js';
import { LIMITS, Opcode, type Frame } from '../protocol/codec.js';
import {
  browserInternalFailure,
  browserProtocolFailure,
  browserRelayFailure,
} from './browser-errors.js';
import { ListenerSet } from './resources.js';
import { validateProtocolValue } from './validation.js';

export interface UserStateHost {
  nextRequestId(): number;
  send(frame: Frame): Promise<void>;
  stateSynchronized(): void;
  transportFailure(error: Error): void;
  emitFailure(error: import('./browser-errors.js').BrowserClientError): void;
}

interface InternalSnapshot {
  readonly epoch: Uint8Array;
  readonly revision: number;
  readonly values: Readonly<Record<string, ProtocolValue>>;
  readonly stale: boolean;
}

function integer(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw browserProtocolFailure(`${label} is invalid`);
  }
  return value;
}

function entries(value: ProtocolValue | undefined, label: string): ProtocolValue[] {
  if (!Array.isArray(value)) throw browserProtocolFailure(`${label} is not an array`);
  return value;
}

function sameEpoch(left: Uint8Array | undefined, right: ProtocolValue | undefined): right is Uint8Array {
  return left !== undefined
    && right instanceof Uint8Array
    && right.length === left.length
    && right.every((value, index) => value === left[index]);
}

function cloneValues(source: Readonly<Record<string, ProtocolValue>>): Readonly<Record<string, ProtocolValue>> {
  const output: Record<string, ProtocolValue> = Object.create(null);
  for (const [path, value] of Object.entries(source)) {
    output[path] = validateProtocolValue(value, `state.${path}`);
  }
  return Object.freeze(output);
}

function publicSnapshot(snapshot: InternalSnapshot): BrowserStateSnapshot {
  return Object.freeze({
    epoch: snapshot.epoch.slice(),
    revision: snapshot.revision,
    values: cloneValues(snapshot.values),
    stale: snapshot.stale,
  });
}

export class UserStateManager implements BrowserState {
  readonly #host: UserStateHost;
  readonly #listeners = new ListenerSet<BrowserStateSnapshot>();
  readonly #paths = new Map<number, string>();
  #epoch: Uint8Array | undefined;
  #snapshot: InternalSnapshot | undefined;
  #dictionarySeen = false;
  #pendingResync: number | undefined;

  constructor(host: UserStateHost) {
    this.#host = host;
  }

  snapshot(): BrowserStateSnapshot | undefined {
    return this.#snapshot === undefined ? undefined : publicSnapshot(this.#snapshot);
  }

  subscribe(listener: (snapshot: BrowserStateSnapshot) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('state listener must be a function');
    const remove = this.#listeners.subscribe(listener);
    if (this.#snapshot !== undefined) {
      try {
        listener(publicSnapshot(this.#snapshot));
      } catch {
        this.#host.emitFailure(browserInternalFailure());
      }
    }
    return remove;
  }

  beginSession(epoch: Uint8Array): void {
    this.#epoch = epoch.slice();
    this.#paths.clear();
    this.#dictionarySeen = false;
    this.#pendingResync = undefined;
  }

  disconnected(): void {
    this.#epoch = undefined;
    this.#paths.clear();
    this.#dictionarySeen = false;
    this.#pendingResync = undefined;
    if (this.#snapshot !== undefined && !this.#snapshot.stale) {
      this.#snapshot = Object.freeze({ ...this.#snapshot, stale: true });
      this.#publish();
    }
  }

  stop(): void {
    this.disconnected();
    this.#listeners.clear();
  }

  handleFrame(frame: Frame): boolean {
    if (frame.opcode === Opcode.StateDict) {
      this.#handleDictionary(frame);
      return true;
    }
    if (frame.opcode === Opcode.StateSnapshot) {
      this.#handleSnapshot(frame);
      return true;
    }
    if (frame.opcode === Opcode.StatePatch) {
      this.#handlePatch(frame);
      return true;
    }
    return false;
  }

  handleError(requestId: number, code: number, retryable: boolean): boolean {
    if (this.#pendingResync !== requestId) return false;
    this.#pendingResync = undefined;
    this.#host.transportFailure(browserRelayFailure(code, retryable, 'not_dispatched'));
    return true;
  }

  #handleDictionary(frame: Frame): void {
    if (!sameEpoch(this.#epoch, frame.payload[0])) {
      throw browserProtocolFailure('STATE_DICT uses a stale epoch');
    }
    const replace = frame.payload[1];
    if (typeof replace !== 'boolean') throw browserProtocolFailure('STATE_DICT.replace is invalid');
    if (!replace && !this.#dictionarySeen) {
      throw browserProtocolFailure('STATE_DICT addition arrived before a replacement');
    }
    const nextPaths = replace ? new Map<number, string>() : new Map(this.#paths);
    const names = new Set(nextPaths.values());
    for (const raw of entries(frame.payload[2], 'STATE_DICT.entries')) {
      const tuple = entries(raw, 'STATE_DICT entry');
      const id = integer(tuple[0], 'STATE_DICT.pathId');
      const path = tuple[1];
      if (typeof path !== 'string') throw browserProtocolFailure('STATE_DICT.path is invalid');
      const existing = nextPaths.get(id);
      if ((existing !== undefined && existing !== path)
        || (names.has(path) && existing !== path)) {
        throw browserProtocolFailure('STATE_DICT reassigns an identifier');
      }
      if (existing === undefined && nextPaths.size >= LIMITS.statePathsPerHome) {
        throw browserProtocolFailure('STATE_DICT exceeds the cumulative path limit');
      }
      nextPaths.set(id, path);
      names.add(path);
    }
    this.#paths.clear();
    for (const [id, path] of nextPaths) this.#paths.set(id, path);
    if (replace) {
      this.#dictionarySeen = true;
      if (this.#snapshot !== undefined && !this.#snapshot.stale) {
        this.#snapshot = Object.freeze({ ...this.#snapshot, stale: true });
        this.#publish();
      }
    }
  }

  #handleSnapshot(frame: Frame): void {
    const epoch = this.#epoch;
    if (epoch === undefined || !sameEpoch(epoch, frame.payload[0]) || !this.#dictionarySeen) {
      throw browserProtocolFailure('STATE_SNAPSHOT has no matching dictionary');
    }
    const revision = integer(frame.payload[1], 'STATE_SNAPSHOT.revision');
    const previous = this.#snapshot;
    if (previous !== undefined
      && sameEpoch(previous.epoch, epoch)
      && revision < previous.revision) {
      throw browserProtocolFailure('STATE_SNAPSHOT rolls back the current epoch');
    }
    const values: Record<string, ProtocolValue> = Object.create(null);
    for (const raw of entries(frame.payload[2], 'STATE_SNAPSHOT.entries')) {
      const tuple = entries(raw, 'STATE_SNAPSHOT entry');
      const path = this.#paths.get(integer(tuple[0], 'STATE_SNAPSHOT.pathId'));
      if (path === undefined || Object.hasOwn(values, path)) {
        throw browserProtocolFailure('STATE_SNAPSHOT references an unknown or duplicate path');
      }
      values[path] = validateProtocolValue(tuple[1], `state.${path}`);
    }
    this.#pendingResync = undefined;
    this.#snapshot = Object.freeze({
      epoch: epoch.slice(),
      revision,
      values: Object.freeze(values),
      stale: false,
    });
    this.#publish();
    this.#host.stateSynchronized();
  }

  #handlePatch(frame: Frame): void {
    const snapshot = this.#snapshot;
    if (snapshot === undefined
      || snapshot.stale
      || !sameEpoch(this.#epoch, frame.payload[0])
      || integer(frame.payload[1], 'STATE_PATCH.baseRevision') !== snapshot.revision) {
      this.#requestResync();
      return;
    }
    const revision = integer(frame.payload[2], 'STATE_PATCH.revision');
    if (revision <= snapshot.revision) {
      this.#requestResync();
      return;
    }
    const values: Record<string, ProtocolValue> = Object.create(null);
    for (const [path, value] of Object.entries(snapshot.values)) values[path] = value;
    for (const raw of entries(frame.payload[3], 'STATE_PATCH.mutations')) {
      const tuple = entries(raw, 'STATE_PATCH mutation');
      const path = this.#paths.get(integer(tuple[0], 'STATE_PATCH.pathId'));
      if (path === undefined) {
        this.#requestResync();
        return;
      }
      if (tuple[1] === 0) values[path] = validateProtocolValue(tuple[2], `state.${path}`);
      else if (tuple[1] === 1) delete values[path];
      else throw browserProtocolFailure('STATE_PATCH mutation kind is invalid');
    }
    this.#snapshot = Object.freeze({
      epoch: snapshot.epoch,
      revision,
      values: Object.freeze(values),
      stale: false,
    });
    this.#publish();
  }

  #requestResync(): void {
    if (this.#snapshot !== undefined && !this.#snapshot.stale) {
      this.#snapshot = Object.freeze({ ...this.#snapshot, stale: true });
      this.#publish();
    }
    if (this.#pendingResync !== undefined) return;
    const requestId = this.#host.nextRequestId();
    this.#pendingResync = requestId;
    void this.#host.send({ opcode: Opcode.StateResync, payload: [requestId] }).catch(() => {
      if (this.#pendingResync !== requestId) return;
      this.#pendingResync = undefined;
      this.#host.transportFailure(browserProtocolFailure('STATE_RESYNC transport failed'));
    });
  }

  #publish(): void {
    if (this.#snapshot === undefined) return;
    const value = publicSnapshot(this.#snapshot);
    this.#listeners.emit(value, () => this.#host.emitFailure(browserInternalFailure()));
  }
}
