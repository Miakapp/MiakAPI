/**
 * The component entry point: handshake, render loop and lifecycle.
 *
 * ABI 1 commits a complete immutable tree per render, so this module owns the
 * only two timing rules that can kill an otherwise correct component: the first
 * render must reach the broker within three seconds of boot, and no more than
 * thirty renders may be committed per rolling second. Commits are therefore
 * coalesced rather than passed through.
 */
import {
  CallManager,
  type CallOptions,
  type CallStream,
} from './calls.js';
import {
  COMPONENT_ABI,
  LIMITS,
  decodeBrokerMessage,
  guestMessage,
  workerTransport,
  type CapabilityGrant,
  type GuestBoot,
  type GuestMessageKind,
  type GuestTransport,
  type LogLevel,
  type StructuredValue,
  type Theme,
  type UiInteraction,
} from './protocol.js';
import { StateStore, type StateView } from './state.js';
import { checkTree, collectHandlers, type Handler, type UiNode } from './ui.js';

export interface EventsView {
  subscribe(name: string, listener: (data: StructuredValue) => void): () => void;
  publish(name: string, data: StructuredValue): void;
}

export interface Home {
  readonly homeId: string;
  readonly generation: number;
  readonly release: string;
  readonly grant: CapabilityGrant;
  /** True while the release is staged: rendering works, calls and events do not. */
  readonly staging: boolean;
  readonly locale: string;
  readonly theme: Theme;
  readonly state: StateView;
  readonly events: EventsView;
  call(name: string, args: StructuredValue, options?: CallOptions): Promise<StructuredValue>;
  stream(name: string, args: StructuredValue, options?: CallOptions): CallStream;
  log(level: LogLevel, message: string): void;
  /** Requests one coalesced re-render. */
  invalidate(): void;
}

export interface Component {
  render(): UiNode;
  dispose?(): void;
}

export type Setup = (home: Home) => Component;

export interface DefineOptions {
  /** Injected by tests; defaults to the ambient Worker scope. */
  readonly transport?: GuestTransport;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => void;
}

export interface ComponentHandle {
  /** Resolves once the first tree has been committed. */
  readonly ready: Promise<void>;
  readonly disposed: boolean;
}

const MINIMUM_RENDER_INTERVAL_MS = Math.ceil(1_000 / LIMITS.rendersPerSecond);

/**
 * Starts one component.
 *
 * The call sends `guest.ready` immediately: the broker gives the Worker three
 * seconds to boot, and the handshake must not wait on any guest work. `setup`
 * runs later, once `guest.boot` and the first authoritative snapshot arrive, so
 * a component never observes state before the grant that justifies it.
 */
export function defineComponent(setup: Setup, options: DefineOptions = {}): ComponentHandle {
  const transport = options.transport ?? workerTransport();
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule
    ?? ((callback, delayMs) => void setTimeout(callback, delayMs));

  const state = new StateStore();
  const listeners = new Map<string, Set<(data: StructuredValue) => void>>();
  /** Handlers from the last committed tree, keyed by node ID. */
  let handlers = new Map<string, Handler>();

  let boot: GuestBoot | undefined;
  let component: Component | undefined;
  let renderRevision = 0;
  let lastRenderAt = Number.NEGATIVE_INFINITY;
  let renderScheduled = false;
  let suspended = false;
  let disposed = false;
  let active = false;

  let signalReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });

  const send = (kind: GuestMessageKind, payload: unknown): void => {
    if (disposed) return;
    transport.post(guestMessage(kind, payload));
  };

  const calls = new CallManager(send);

  const log = (level: LogLevel, message: string): void => {
    send('log.write', { level, message: message.slice(0, LIMITS.logMessageBytes) });
  };

  const home: Home = {
    get homeId() {
      return requireBoot().home_id;
    },
    get generation() {
      return requireBoot().generation;
    },
    get release() {
      return requireBoot().release;
    },
    get grant() {
      return requireBoot().grant;
    },
    get staging() {
      return requireBoot().staging;
    },
    get locale() {
      return requireBoot().locale;
    },
    get theme() {
      return requireBoot().theme;
    },
    state,
    events: {
      subscribe(name, listener) {
        const existing = listeners.get(name);
        if (existing === undefined) {
          listeners.set(name, new Set([listener]));
          send('event.subscribe', { name });
        } else {
          existing.add(listener);
        }
        return () => {
          const current = listeners.get(name);
          if (current === undefined) return;
          current.delete(listener);
          if (current.size > 0) return;
          listeners.delete(name);
          send('event.unsubscribe', { name });
        };
      },
      publish(name, data) {
        requireOperable('publish an event');
        send('event.publish', { name, data });
      },
    },
    call: (name, args, callOptions) => {
      requireOperable('start a call');
      return calls.call(name, args, callOptions);
    },
    stream: (name, args, callOptions) => {
      requireOperable('start a call');
      return calls.stream(name, args, callOptions);
    },
    log,
    invalidate: () => requestRender(),
  };

  function requireBoot(): GuestBoot {
    if (boot === undefined) {
      throw new Error('The component is not booted yet; use the Home passed to setup');
    }
    return boot;
  }

  /**
   * Refuses an operation the broker would answer by terminating the instance.
   *
   * `event.publish`, `call.start`, `call.credit` and `call.cancel` are denied
   * while the runtime is staged, suspended or inactive, and a denial in the
   * broker is fatal rather than an error reply. Failing locally keeps the
   * component alive and gives the author a message that names the state.
   */
  function requireOperable(action: string): void {
    if (disposed) throw new Error(`Cannot ${action}: the component instance was disposed`);
    if (!active) throw new Error(`Cannot ${action}: the component is not active yet`);
    if (suspended) throw new Error(`Cannot ${action}: the component is suspended`);
    if (requireBoot().staging) {
      throw new Error(`Cannot ${action}: a staged release may render but not act on the home`);
    }
  }

  function commit(): void {
    const current = component;
    if (disposed || suspended || current === undefined) return;
    const collected = collectHandlers(() => current.render());
    const tree = checkTree(collected.result);
    handlers = collected.handlers;
    renderRevision += 1;
    lastRenderAt = now();
    send('ui.render', { revision: renderRevision, tree });
    signalReady();
  }

  /**
   * Coalesces renders and spaces them at the ABI rate.
   *
   * A component that calls `invalidate()` in a loop, or a burst of state
   * patches, must not turn into thirty-one commits in a second: the broker
   * would terminate the instance rather than drop the extra render.
   */
  function requestRender(): void {
    if (disposed || suspended || component === undefined || renderScheduled) return;
    renderScheduled = true;
    const wait = Math.max(0, MINIMUM_RENDER_INTERVAL_MS - (now() - lastRenderAt));
    schedule(() => {
      renderScheduled = false;
      commit();
    }, wait);
  }

  function start(): void {
    if (component !== undefined) return;
    component = setup(home);
    commit();
  }

  function dispatchInteraction(interaction: UiInteraction): void {
    if (interaction.render_revision !== renderRevision) return;
    const handler = handlers.get(interaction.node_id);
    if (handler === undefined) return;
    if (interaction.event === 'press') (handler as () => void)();
    else (handler as (value: boolean | string) => void)(interaction.value as boolean | string);
    requestRender();
  }

  function teardown(): void {
    if (disposed) return;
    disposed = true;
    calls.abortAll(new Error('The component instance was disposed'));
    try {
      component?.dispose?.();
    } finally {
      component = undefined;
    }
  }

  transport.subscribe((data) => {
    const message = decodeBrokerMessage(data);
    if (message === undefined || disposed) return;
    switch (message.kind) {
      case 'guest.boot':
        boot = message.payload;
        active = true;
        break;
      case 'state.snapshot':
        state.applySnapshot(message.payload);
        if (component === undefined) start();
        else requestRender();
        break;
      case 'state.patch':
        if (state.applyPatch(message.payload)) requestRender();
        break;
      case 'state.stale':
        state.markStale(message.payload);
        requestRender();
        break;
      case 'event.message': {
        const subscribers = listeners.get(message.payload.name);
        if (subscribers === undefined) break;
        for (const listener of [...subscribers]) listener(message.payload.data);
        requestRender();
        break;
      }
      case 'call.accepted':
        calls.accept(message.payload.operation_id);
        break;
      case 'call.chunk':
        calls.chunk(message.payload);
        break;
      case 'call.result':
        calls.result(message.payload);
        break;
      case 'call.error':
        calls.fail(message.payload);
        break;
      case 'call.outcome_unknown':
        calls.outcomeUnknown(message.payload);
        break;
      case 'ui.interaction':
        dispatchInteraction(message.payload);
        break;
      case 'lifecycle.suspend':
        suspended = true;
        break;
      case 'lifecycle.resume':
        suspended = false;
        active = message.payload.active;
        requestRender();
        break;
      case 'lifecycle.dispose':
        teardown();
        break;
    }
  });

  send('guest.ready', { abi: COMPONENT_ABI });

  return {
    ready,
    get disposed() {
      return disposed;
    },
  };
}

export type { CallOptions, CallStream };
