import { describe, expect, test } from 'bun:test';

import { STATE } from '../coordinator/home.js';
import { buildView, phaseAfterFailure } from '../app/view.js';

const current = {
  values: { [STATE.lightOn]: false, [STATE.temperature]: 21.46, [STATE.health]: 'healthy' },
  revision: 4,
  stale: false,
};

describe('house app view', () => {
  test('shows current values and offers the lamp when the home can act', () => {
    const view = buildView('Maison', current, 'idle', true);
    expect(view.temperature).toBe('21.5 °C');
    expect(view.light).toMatchObject({ on: false, usable: true, label: 'Turn on' });
  });

  test('never presents stale values as current and freezes the control', () => {
    const view = buildView('Maison', { ...current, stale: true }, 'idle', true);
    expect(view.stale).toBe(true);
    expect(view.temperature).toBeUndefined();
    expect(view.light.usable).toBe(false);
  });

  test('keeps the control off when the resident may not call or the home is down', () => {
    expect(buildView('Maison', current, 'idle', false).light.usable).toBe(false);
    const down = { ...current, values: { ...current.values, [STATE.health]: 'degraded' } };
    expect(buildView('Maison', down, 'idle', true).light.usable).toBe(false);
  });

  test('treats an unknown outcome as "wait for state", never as a failure to retry', () => {
    expect(phaseAfterFailure('outcome_unknown')).toBe('unknown');
    expect(phaseAfterFailure('timeout')).toBe('unknown');
    expect(phaseAfterFailure('denied')).toBe('failed');
    expect(buildView('Maison', current, 'unknown', true).light.note).toContain('may have acted');
    expect(buildView('Maison', current, 'sending', true).light.usable).toBe(false);
  });
});
