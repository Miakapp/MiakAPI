/**
 * The guest half of the ABI 1 bridge.
 *
 * Shapes here mirror `component-runtime/src/runtime-broker.ts` exactly. The
 * broker is the authority: it validates every field, and one unknown key, one
 * missing key or one out-of-range number terminates the instance. Nothing in
 * this file is inferred from prose — each payload matches the record the broker
 * builds or destructures.
 */

export const COMPONENT_ABI = 'miakapp.component/1';

/** The guest envelope is `{ v, kind, payload }`; instance, epoch and seq are host/broker only. */
export const BROKER_PROTOCOL = 1;

export const LIMITS = Object.freeze({
  uiNodes: 1_024,
  uiDepth: 32,
  uiTextBytes: 262_144,
  textBytes: 8_192,
  inputBytes: 16_384,
  selectOptions: 100,
  outstandingCalls: 32,
  callCredit: 32,
  callDeadlineMs: 300_000,
  guestMessagesPerSecond: 120,
  rendersPerSecond: 30,
  logMessageBytes: 2_048,
});

export type RequirementKind =
  | 'state_read'
  | 'event_subscribe'
  | 'event_publish'
  | 'call'
  | 'presentation';

export type CapabilityGrant = {
  readonly [Kind in RequirementKind]: readonly string[];
};

export type Theme = 'light' | 'dark' | 'system';

export interface GuestBoot {
  readonly home_id: string;
  readonly generation: number;
  readonly release: string;
  readonly abi: string;
  readonly grant: CapabilityGrant;
  readonly staging: boolean;
  readonly locale: string;
  readonly theme: Theme;
}

export type StructuredValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly StructuredValue[]
  | { readonly [key: string]: StructuredValue };

export interface StateSnapshot {
  readonly revision: number;
  readonly values: Readonly<Record<string, StructuredValue>>;
}

export type StateMutation =
  | { readonly path: string; readonly op: 'set'; readonly value: StructuredValue }
  | { readonly path: string; readonly op: 'delete' };

export interface StatePatch {
  readonly base_revision: number;
  readonly revision: number;
  readonly mutations: readonly StateMutation[];
}

export interface StateStale {
  readonly revision: number;
  readonly reason: string;
}

export interface EventMessage {
  readonly name: string;
  readonly data: StructuredValue;
}

export interface CallAccepted {
  readonly operation_id: number;
}

export interface CallChunk {
  readonly operation_id: number;
  readonly value: StructuredValue;
}

export interface CallResult {
  readonly operation_id: number;
  readonly value: StructuredValue;
}

export interface CallFailure {
  readonly operation_id: number;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: StructuredValue;
}

export interface CallOutcomeUnknown {
  readonly operation_id: number;
  readonly message?: string;
}

export type InteractionEvent = 'press' | 'change';

export interface UiInteraction {
  readonly render_revision: number;
  readonly node_id: string;
  readonly handler: string;
  readonly event: InteractionEvent;
  readonly value?: boolean | string;
}

export interface LifecycleResume {
  readonly active: boolean;
  readonly epoch: number;
}

/**
 * Broker-to-guest messages, as the closed set the broker actually sends.
 *
 * `runtime.probe` is absent on purpose: the trusted prelude answers the
 * heartbeat with a captured native `postMessage` before guest code runs, and
 * RFC 0002 §12.1 requires a guest SDK to ignore reserved runtime messages
 * rather than reply to them.
 */
export type BrokerMessage =
  | { readonly kind: 'guest.boot'; readonly payload: GuestBoot }
  | { readonly kind: 'state.snapshot'; readonly payload: StateSnapshot }
  | { readonly kind: 'state.patch'; readonly payload: StatePatch }
  | { readonly kind: 'state.stale'; readonly payload: StateStale }
  | { readonly kind: 'event.message'; readonly payload: EventMessage }
  | { readonly kind: 'call.accepted'; readonly payload: CallAccepted }
  | { readonly kind: 'call.chunk'; readonly payload: CallChunk }
  | { readonly kind: 'call.result'; readonly payload: CallResult }
  | { readonly kind: 'call.error'; readonly payload: CallFailure }
  | { readonly kind: 'call.outcome_unknown'; readonly payload: CallOutcomeUnknown }
  | { readonly kind: 'ui.interaction'; readonly payload: UiInteraction }
  | { readonly kind: 'lifecycle.suspend'; readonly payload: Record<string, never> }
  | { readonly kind: 'lifecycle.resume'; readonly payload: LifecycleResume }
  | { readonly kind: 'lifecycle.dispose'; readonly payload: Record<string, never> };

const BROKER_KINDS = new Set<BrokerMessage['kind']>([
  'guest.boot',
  'state.snapshot',
  'state.patch',
  'state.stale',
  'event.message',
  'call.accepted',
  'call.chunk',
  'call.result',
  'call.error',
  'call.outcome_unknown',
  'ui.interaction',
  'lifecycle.suspend',
  'lifecycle.resume',
  'lifecycle.dispose',
]);

export type GuestMessageKind =
  | 'guest.ready'
  | 'ui.render'
  | 'event.subscribe'
  | 'event.unsubscribe'
  | 'event.publish'
  | 'call.start'
  | 'call.credit'
  | 'call.cancel'
  | 'log.write';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Reads one broker message, or `undefined` for anything this SDK must ignore.
 *
 * Ignoring rather than throwing is deliberate. A reserved `runtime.*` control
 * message and a kind added by a newer broker are both none of the guest's
 * business, and a guest that threw on them would turn a forward-compatible
 * platform change into a terminated component.
 */
export function decodeBrokerMessage(data: unknown): BrokerMessage | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (record['v'] !== BROKER_PROTOCOL) return undefined;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !BROKER_KINDS.has(kind as BrokerMessage['kind'])) {
    return undefined;
  }
  const payload = record['payload'];
  if (payload === null || typeof payload !== 'object') return undefined;
  return { kind, payload } as BrokerMessage;
}

/** The transport the guest owns. Tests substitute it; the Worker default is below. */
export interface GuestTransport {
  post(message: unknown): void;
  subscribe(handler: (data: unknown) => void): void;
}

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * The ambient Worker scope, after the trusted prelude has shadowed every
 * network and storage entry point. `postMessage` and `addEventListener` are the
 * only globals the guest is left with, and they are captured once here.
 */
export function workerTransport(): GuestTransport {
  const scope = globalThis as unknown as Partial<WorkerScope>;
  const post = scope.postMessage;
  const listen = scope.addEventListener;
  if (typeof post !== 'function' || typeof listen !== 'function') {
    throw new Error('@miakapp/component must run inside the component runtime Worker');
  }
  const boundPost = post.bind(scope);
  const boundListen = listen.bind(scope);
  return {
    post: (message) => void boundPost(message),
    subscribe: (handler) => void boundListen('message', (event) => handler(event.data)),
  };
}

export function guestMessage(kind: GuestMessageKind, payload: unknown): unknown {
  return { v: BROKER_PROTOCOL, kind, payload };
}
