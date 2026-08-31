import type {
  CoordinatorLogger,
  CoordinatorPresence,
  PresenceEntry,
  Unsubscribe,
} from '../api.js';
import { Opcode, type Frame, type ProtocolValue } from '../protocol/codec.js';
import { safeLog } from './errors.js';
import { ListenerSet } from './resources.js';

export interface PresenceHost {
  logger(): CoordinatorLogger | undefined;
}

function entry(value: ProtocolValue, label: string): PresenceEntry {
  if (!Array.isArray(value)
    || typeof value[0] !== 'number'
    || !Number.isSafeInteger(value[0])
    || typeof value[1] !== 'string') {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({ sessionId: value[0], userId: value[1] });
}

export class PresenceManager implements CoordinatorPresence {
  readonly #host: PresenceHost;
  readonly #listeners = new ListenerSet<readonly PresenceEntry[]>();
  readonly #entries = new Map<number, PresenceEntry>();

  constructor(host: PresenceHost) {
    this.#host = host;
  }

  snapshot(): readonly PresenceEntry[] {
    return Object.freeze(
      [...this.#entries.values()]
        .sort((left, right) => left.sessionId - right.sessionId)
        .map((value) => Object.freeze({ ...value })),
    );
  }

  subscribe(listener: (entries: readonly PresenceEntry[]) => void): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('presence listener must be a function');
    const unsubscribe = this.#listeners.subscribe(listener);
    try {
      listener(this.snapshot());
    } catch {
      safeLog(this.#host.logger(), { level: 'error', event: 'presence_listener_failed' });
    }
    return unsubscribe;
  }

  handleFrame(frame: Frame): boolean {
    if (frame.opcode === Opcode.PresenceSnapshot) {
      const values = frame.payload[0];
      if (!Array.isArray(values)) throw new TypeError('PRESENCE_SNAPSHOT entries are invalid');
      const next = new Map<number, PresenceEntry>();
      values.forEach((value, index) => {
        const presence = entry(value, `PRESENCE_SNAPSHOT[${index}]`);
        if (next.has(presence.sessionId)) {
          throw new TypeError('PRESENCE_SNAPSHOT contains a duplicate session');
        }
        next.set(presence.sessionId, presence);
      });
      this.#entries.clear();
      for (const [sessionId, presence] of next) this.#entries.set(sessionId, presence);
      this.#emit();
      return true;
    }
    if (frame.opcode === Opcode.PresenceChange) {
      const sessionId = frame.payload[0];
      const userId = frame.payload[1];
      const change = frame.payload[2];
      if (typeof sessionId !== 'number'
        || !Number.isSafeInteger(sessionId)
        || typeof userId !== 'string'
        || (change !== 1 && change !== 2)) {
        throw new TypeError('PRESENCE_CHANGE is invalid');
      }
      const existing = this.#entries.get(sessionId);
      if (change === 1) {
        if (existing !== undefined) throw new TypeError('PRESENCE_CHANGE duplicates a session');
        this.#entries.set(sessionId, Object.freeze({ sessionId, userId }));
      } else {
        if (existing === undefined || existing.userId !== userId) {
          throw new TypeError('PRESENCE_CHANGE disconnects an unknown session');
        }
        this.#entries.delete(sessionId);
      }
      this.#emit();
      return true;
    }
    return false;
  }

  disconnected(): void {
    if (this.#entries.size === 0) return;
    this.#entries.clear();
    this.#emit();
  }

  stop(): void {
    this.disconnected();
    this.#listeners.clear();
  }

  #emit(): void {
    this.#listeners.emit(this.snapshot(), () => {
      safeLog(this.#host.logger(), { level: 'error', event: 'presence_listener_failed' });
    });
  }
}
