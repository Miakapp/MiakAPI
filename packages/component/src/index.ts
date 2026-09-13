/**
 * `@miakapp/component` — the guest SDK for a Miakapp home component.
 *
 * The component runs inside a sandboxed Worker with no network, no storage and
 * no DOM. Everything it can do arrives through the bridge: a granted state
 * projection, granted events, granted calls, and one complete semantic tree per
 * render. This module is the whole public surface.
 */
export {
  defineComponent,
  type Component,
  type ComponentHandle,
  type DefineOptions,
  type EventsView,
  type Home,
  type Setup,
} from './component.js';

export {
  CallCancelledError,
  CallError,
  CallOutcomeUnknownError,
  CallManager,
  type CallOptions,
  type CallStream,
} from './calls.js';

export { StateStore, type StateView } from './state.js';

export {
  COMPONENT_ABI,
  LIMITS,
  decodeBrokerMessage,
  guestMessage,
  workerTransport,
  type CapabilityGrant,
  type GuestBoot,
  type GuestTransport,
  type LogLevel,
  type RequirementKind,
  type StructuredValue,
  type Theme,
  type UiInteraction,
} from './protocol.js';

export * as ui from './ui.js';
export { UiError, checkTree, type UiNode, type UiNodeType } from './ui.js';
