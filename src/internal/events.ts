import type {
  CoordinatorEvents,
  CoordinatorLogger,
  DeclarationOptions,
  EventDeclaration,
  EventHandle,
  EventTarget,
  IncomingEvent,
  OperationOptions,
  Principal,
  ProtocolValue,
  SentEvent,
  Unsubscribe,
} from '../api.js';
import { Opcode, type Frame } from '../protocol/codec.js';
import type { ActiveDeclarations, DeclarationManager } from './declarations.js';
import { cancelled, outcomeUnknown, relayFailure, safeLog, unavailable } from './errors.js';
import { createDeferred, ListenerSet, type Deferred } from './resources.js';
import type { RelaySession } from './session.js';
import {
  targetFields,
  validateDeclarationOptions,
  validateEventDeclarations,
  validateEventPublishOptions,
  validateProtocolValue,
  validateStructuredName,
} from './validation.js';

export interface EventHost {
  readySession(): RelaySession | undefined;
  activeDeclarations(): ActiveDeclarations | undefined;
  nextEventId(): number;
  nextLocalEventId(): number;
  emitFailure(failure: ReturnType<typeof relayFailure>): void;
  logger(): CoordinatorLogger | undefined;
}

interface PublishedEvent {
  localId: string;
  sent: Deferred<SentEvent>;
  handedOff: boolean;
  signal?: AbortSignal;
  abort?: () => void;
}

function principal(value: ProtocolValue | undefined): Principal {
  if (!Array.isArray(value)) throw new TypeError('EVENT source is not a principal');
  const kind = value[0] === 1 ? 'user' : value[0] === 2 ? 'coordinator' : value[0] === 3 ? 'cli' : undefined;
  if (kind === undefined
    || typeof value[1] !== 'string'
    || typeof value[2] !== 'number'
    || (value[3] !== null && typeof value[3] !== 'string')
    || (value[4] !== null && typeof value[4] !== 'string')) {
    throw new TypeError('EVENT source principal is invalid');
  }
  return Object.freeze({
    kind,
    id: value[1],
    sessionId: value[2],
    coordinatorName: value[3],
    verifiedEmail: value[4],
  });
}

function topicForId(active: ActiveDeclarations, id: number): string | undefined {
  for (const [topic, topicId] of active.topicIds) {
    if (topicId === id) return topic;
  }
  return undefined;
}

export class EventManager implements CoordinatorEvents {
  readonly #host: EventHost;
  readonly #declarations: DeclarationManager;
  readonly #listeners = new Map<string, ListenerSet<IncomingEvent>>();
  readonly #published = new Map<number, PublishedEvent>();
  #eventSessionId: number | undefined;
  #lastEventId = 0;

  constructor(host: EventHost, declarations: DeclarationManager) {
    this.#host = host;
    this.#declarations = declarations;
  }

  declare(
    entries: readonly EventDeclaration[],
    options: DeclarationOptions = {},
  ): Promise<import('../api.js').DeclarationReceipt> {
    const signal = validateDeclarationOptions(options, 'event declaration');
    return this.#declarations.declareEvents(validateEventDeclarations(entries), signal);
  }

  publish(
    topic: string,
    value: ProtocolValue,
    options: OperationOptions & { target?: EventTarget } = {},
  ): EventHandle {
    const validatedTopic = validateStructuredName(topic, 'event topic');
    const validatedValue = validateProtocolValue(value, 'event value');
    const validatedOptions = validateEventPublishOptions(options);
    const signal = validatedOptions.signal;
    const defaultTarget: EventTarget = Object.freeze({ kind: 'default' });
    const target = validatedOptions.target === undefined
      ? defaultTarget
      : validatedOptions.target;
    if (signal?.aborted === true) {
      const sent = createDeferred<SentEvent>();
      const handle = Object.freeze({
        localId: `event:local:${this.#host.nextLocalEventId()}`,
        sent: sent.promise,
      });
      sent.reject(cancelled('not_dispatched'));
      return handle;
    }
    const session = this.#host.readySession();
    const active = this.#host.activeDeclarations();
    const topicId = active?.topicIds.get(validatedTopic);
    if (session === undefined || active === undefined || topicId === undefined) {
      const sent = createDeferred<SentEvent>();
      const handle = Object.freeze({
        localId: `event:local:${this.#host.nextLocalEventId()}`,
        sent: sent.promise,
      });
      sent.reject(unavailable('Event topic is not active in a ready session'));
      return handle;
    }
    const eventId = this.#host.nextEventId();
    const sessionId = session.welcome.readySession.sessionId;
    if (this.#eventSessionId !== sessionId) {
      this.#eventSessionId = sessionId;
      this.#lastEventId = 0;
    }
    this.#lastEventId = eventId;
    const localId = `event:${sessionId}:${eventId}`;
    const sent = createDeferred<SentEvent>();
    const handle = Object.freeze({ localId, sent: sent.promise });
    const pending: PublishedEvent = { localId, sent, handedOff: false };
    if (signal !== undefined) {
      const abort = () => {
        if (!this.#published.delete(eventId)) return;
        sent.reject(pending.handedOff ? outcomeUnknown() : cancelled('not_dispatched'));
      };
      pending.signal = signal;
      pending.abort = abort;
      signal.addEventListener('abort', abort, { once: true });
    }
    this.#published.set(eventId, pending);
    const [targetKind, targetValue] = targetFields(target);
    pending.handedOff = true;
    void session.send({
      opcode: Opcode.Event,
      payload: [eventId, topicId, targetKind, targetValue, validatedValue],
    }).then(() => {
      if (this.#published.get(eventId) !== pending) return;
      this.#published.delete(eventId);
      this.#removeAbort(pending);
      sent.resolve(Object.freeze({ outcome: 'sent' }));
    }, () => {
      if (this.#published.get(eventId) !== pending) return;
      this.#published.delete(eventId);
      this.#removeAbort(pending);
      sent.reject(unavailable('Event was not handed to the transport'));
    });
    return handle;
  }

  subscribe(topic: string, listener: (event: IncomingEvent) => void): Unsubscribe {
    const validatedTopic = validateStructuredName(topic, 'event subscription topic');
    if (typeof listener !== 'function') throw new TypeError('event listener must be a function');
    let listeners = this.#listeners.get(validatedTopic);
    if (listeners === undefined) {
      listeners = new ListenerSet();
      this.#listeners.set(validatedTopic, listeners);
    }
    const unsubscribe = listeners.subscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unsubscribe();
      if (listeners?.size === 0) this.#listeners.delete(validatedTopic);
    };
  }

  handleFrame(frame: Frame): boolean {
    if (frame.opcode !== Opcode.Event) return false;
    const topicId = frame.payload[1];
    if (typeof topicId !== 'number') throw new TypeError('EVENT has no topic ID');
    const active = this.#host.activeDeclarations();
    if (active === undefined) throw new TypeError('EVENT arrived without active declarations');
    const topic = topicForId(active, topicId);
    if (topic === undefined) throw new TypeError('EVENT uses an unknown topic ID');
    const event = Object.freeze({
      source: principal(frame.payload[4]),
      topic,
      value: validateProtocolValue(frame.payload[5], 'incoming event value'),
    });
    this.#listeners.get(topic)?.emit(event, () => {
      safeLog(this.#host.logger(), { level: 'error', event: 'event_listener_failed' });
    });
    return true;
  }

  handleError(eventId: number, code: number, retryable: boolean): boolean {
    const pending = this.#published.get(eventId);
    let localId: string;
    if (pending === undefined) {
      if (this.#eventSessionId === undefined || eventId < 1 || eventId > this.#lastEventId) {
        return false;
      }
      localId = `event:${this.#eventSessionId}:${eventId}`;
    } else {
      this.#published.delete(eventId);
      this.#removeAbort(pending);
      pending.handedOff = true;
      pending.sent.resolve(Object.freeze({ outcome: 'sent' }));
      localId = pending.localId;
    }
    const failure = relayFailure(code, retryable, 'sent', {
      kind: 'event',
      localId,
    });
    if (pending === undefined) this.#host.emitFailure(failure);
    else void pending.sent.promise.then(() => this.#host.emitFailure(failure));
    return true;
  }

  disconnected(): void {
    for (const pending of this.#published.values()) {
      this.#removeAbort(pending);
      if (!pending.sent.settled) {
        pending.sent.reject(pending.handedOff ? outcomeUnknown() : unavailable());
      }
    }
    this.#published.clear();
    this.#eventSessionId = undefined;
    this.#lastEventId = 0;
  }

  stop(): void {
    this.disconnected();
    this.#listeners.clear();
  }

  #removeAbort(pending: PublishedEvent): void {
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
  }
}
