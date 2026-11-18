/**
 * Typed access to a Miakapp whole-house application's one window on its home.
 *
 * A `miakapp.app/1` release is a single classic-script bundle that owns its
 * whole document: any DOM, CSS, router or UI library. It runs in an isolated
 * opaque-origin frame with no network and no storage, and the trusted shell
 * installs exactly one object before the bundle runs: `window.miakapp`. This
 * package types that object and adds the few helpers every house needs, so a
 * house reads state and calls functions without reaching for `any`.
 *
 * Nothing here grants anything. What the house may read and call is its
 * release's `requires`, narrowed by the coordinator per resident; a path the
 * resident may not see never reaches the frame.
 */

export const APP_ABI = 'miakapp.app/1' as const;

export const CALL_ERROR_CODES = [
  'denied',
  'unavailable',
  'failed',
  'outcome_unknown',
  'timeout',
  'busy',
] as const;

/**
 * Why a call did not complete. `outcome_unknown` means the home may have acted:
 * never retry it, wait for the next state instead.
 */
export type CallErrorCode = (typeof CALL_ERROR_CODES)[number];

export type Theme = 'system' | 'light' | 'dark';

/** Icons a home may give its buttons in the Miakapp bar; Miakapp draws them. */
export const BAR_ICONS = [
  'grid', 'bolt', 'light', 'thermometer', 'camera', 'lock', 'list', 'chart', 'leaf', 'star',
  'people', 'bell',
] as const;
export type BarIcon = (typeof BAR_ICONS)[number];

/** One of the home's (at most two) buttons in the Miakapp bar. */
export interface BarButton {
  /** `[a-z0-9-]`, at most 32 characters. */
  readonly id: string;
  /** At most 16 characters. */
  readonly label: string;
  readonly icon: BarIcon;
  /** The screen shown now; at most one button. */
  readonly active?: boolean;
  /** A count drawn on the button (requests waiting…): integer 0..999, 0 shows none. */
  readonly badge?: number;
}

export interface HomeState {
  readonly values: Readonly<Record<string, unknown>>;
  readonly revision: number;
  /** True when Miakapp no longer has a current view: show it, never hide it. */
  readonly stale: boolean;
}

/** The object the trusted shell installs as `window.miakapp`. */
export interface MiakappHost {
  readonly abi: typeof APP_ABI;
  readonly release: string;
  readonly home: { readonly id: string; readonly name: string };
  readonly locale: string;
  readonly theme: string;
  onThemeChange(listener: (theme: string) => void): () => void;
  readonly state: {
    get(path: string): unknown;
    values(): Readonly<Record<string, unknown>>;
    readonly revision: number;
    readonly stale: boolean;
    subscribe(listener: (state: HomeState) => void): () => void;
  };
  readonly can: { read(path: string): boolean; call(name: string): boolean };
  call(name: string, args?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  ready(): void;
  /** Absent on shells older than the bottom bar. */
  readonly bar?: {
    setButtons(buttons: readonly BarButton[]): void;
    onSelect(listener: (id: string | null) => void): () => void;
  };
}

export class MiakappUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiakappUnavailableError';
  }
}

export interface Home {
  readonly id: string;
  readonly name: string;
  readonly release: string;
  /** BCP 47 language of the resident, e.g. `fr`. */
  readonly locale: string;
  theme(): Theme;
  onThemeChange(listener: (theme: Theme) => void): () => void;
  /** The current granted view, immutable. */
  state(): HomeState;
  get<T = unknown>(path: string): T | undefined;
  /** Granted paths, optionally under one dotted prefix, sorted. */
  paths(prefix?: string): string[];
  /**
   * Calls `listener` with every new view. With `immediate` (the default) it is
   * also called once now, so a render function can be the only listener.
   */
  subscribe(listener: (state: HomeState) => void, options?: { immediate?: boolean }): () => void;
  canRead(path: string): boolean;
  canCall(name: string): boolean;
  /** Rejects with an error whose `callErrorCode()` is one of `CALL_ERROR_CODES`. */
  call<T = unknown>(name: string, args?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  /** Lifts the shell's loading screen before the script finishes, if you want. */
  ready(): void;
  /**
   * The home's own buttons in the Miakapp bar, between the home tab and « Me ».
   * Miakapp keeps the last list for the next visit; set it on every start.
   * `onSelect` gets the tapped button's id, or `null` for the home tab.
   */
  readonly bar: {
    setButtons(buttons: readonly BarButton[]): void;
    onSelect(listener: (id: string | null) => void): () => void;
  };
}

function theme(value: string): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function isHost(value: unknown): value is MiakappHost {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<MiakappHost>;
  return candidate.abi === APP_ABI
    && typeof candidate.call === 'function'
    && typeof candidate.state === 'object'
    && typeof candidate.state?.subscribe === 'function';
}

/**
 * Connects to the home this frame was opened for. Throws when not running
 * inside a Miakapp house frame — for example in a unit test or a plain browser
 * tab — so a mistake fails loudly instead of rendering an empty home.
 */
export function connect(scope: { readonly miakapp?: unknown } = globalThis as { miakapp?: unknown }): Home {
  const host = scope.miakapp;
  if (!isHost(host)) {
    throw new MiakappUnavailableError(
      'window.miakapp is missing: this bundle runs only inside a Miakapp house frame',
    );
  }
  const snapshot = (): HomeState => ({
    values: host.state.values(),
    revision: host.state.revision,
    stale: host.state.stale,
  });
  return Object.freeze({
    id: host.home.id,
    name: host.home.name,
    release: host.release,
    locale: host.locale,
    theme: () => theme(host.theme),
    onThemeChange: (listener: (value: Theme) => void) => host.onThemeChange((value) => listener(theme(value))),
    state: snapshot,
    get: <T>(path: string) => host.state.get(path) as T | undefined,
    paths: (prefix?: string) => Object.keys(host.state.values())
      .filter((path) => prefix === undefined || path === prefix || path.startsWith(`${prefix}.`))
      .sort(),
    subscribe: (listener: (state: HomeState) => void, options: { immediate?: boolean } = {}) => {
      const unsubscribe = host.state.subscribe(listener);
      if (options.immediate ?? true) listener(snapshot());
      return unsubscribe;
    },
    canRead: (path: string) => host.can.read(path),
    canCall: (name: string) => host.can.call(name),
    call: async <T>(name: string, args?: unknown, options?: { timeoutMs?: number }) => (
      await host.call(name, args ?? null, options ?? {}) as T
    ),
    ready: () => host.ready(),
    bar: Object.freeze({
      setButtons: (buttons: readonly BarButton[]) => host.bar?.setButtons(buttons),
      onSelect: (listener: (id: string | null) => void) => host.bar?.onSelect(listener) ?? (() => undefined),
    }),
  });
}

/** The closed reason a call failed, or undefined for anything else. */
export function callErrorCode(error: unknown): CallErrorCode | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return (CALL_ERROR_CODES as readonly unknown[]).includes(code) ? code as CallErrorCode : undefined;
}
