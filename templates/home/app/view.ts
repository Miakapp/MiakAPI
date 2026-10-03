/**
 * What the house shows, derived from the granted state alone. Pure, so the
 * interface's decisions — which values are current, which control is usable,
 * what a failed call means — are tested without a browser.
 */
import type { CallErrorCode, HomeState } from '@miakapp/app';

import { STATE } from '../coordinator/home.js';

export type LightPhase = 'idle' | 'sending' | 'failed' | 'unknown';

export interface HomeView {
  readonly title: string;
  readonly stale: boolean;
  readonly temperature: string | undefined;
  readonly light: {
    readonly on: boolean | undefined;
    readonly usable: boolean;
    readonly label: string;
    readonly note: string | undefined;
  };
  readonly healthy: boolean;
}

export function buildView(
  homeName: string,
  state: HomeState,
  phase: LightPhase,
  canCall: boolean,
): HomeView {
  const temperature = state.values[STATE.temperature];
  const on = state.values[STATE.lightOn];
  const healthy = state.values[STATE.health] === 'healthy';
  const lightOn = typeof on === 'boolean' ? on : undefined;
  return {
    title: homeName,
    stale: state.stale,
    healthy,
    temperature: typeof temperature === 'number' && !state.stale
      ? `${temperature.toFixed(1)} °C`
      : undefined,
    light: {
      on: lightOn,
      usable: canCall && healthy && !state.stale && lightOn !== undefined && phase !== 'sending',
      label: phase === 'sending' ? 'Sending…' : lightOn === true ? 'Turn off' : 'Turn on',
      note: phase === 'failed'
        ? 'The home did not apply it.'
        : phase === 'unknown'
          ? 'The home may have acted; waiting for its state.'
          : undefined,
    },
  };
}

/** A failed call's code, mapped to what the interface does next. */
export function phaseAfterFailure(code: CallErrorCode | undefined): LightPhase {
  return code === 'outcome_unknown' || code === 'timeout' ? 'unknown' : 'failed';
}
