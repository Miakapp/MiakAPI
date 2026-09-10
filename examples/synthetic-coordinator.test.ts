import { describe, expect, mock, test } from 'bun:test';

import { createSyntheticConfiguration } from './synthetic-coordinator';

describe('synthetic Bun coordinator example', () => {
  test('publishes the browser state contract for its owner', () => {
    const configuration = createSyntheticConfiguration({
      ownerUserId: 'owner-user',
      setLightState: async () => undefined,
    });

    expect(configuration.state['zone.alpha.light.on']).toBe(false);
    expect(configuration.stateAccess).toEqual([{
      userId: 'owner-user',
      patterns: expect.arrayContaining(['zone.*', 'climate.*', 'service.*']),
    }]);
    expect(configuration.functions['lighting.toggle']).toBeFunction();
  });

  test('toggles state exactly once per valid call', async () => {
    const setLightState = mock(async (_on: boolean) => undefined);
    const configuration = createSyntheticConfiguration({ ownerUserId: 'owner-user', setLightState });
    const toggle = configuration.functions['lighting.toggle']!;
    const call = {
      source: {
        kind: 'user' as const,
        id: 'owner-user',
        sessionId: 1,
        coordinatorName: null,
        verifiedEmail: null,
      },
      arguments: null,
      idempotencyKey: 'intent-1',
      signal: new AbortController().signal,
      emit: async () => undefined,
    };

    await expect(toggle(call)).resolves.toEqual({ on: true });
    await expect(toggle(call)).resolves.toEqual({ on: false });
    expect(setLightState).toHaveBeenCalledTimes(2);
    expect(setLightState).toHaveBeenNthCalledWith(1, true);
    expect(setLightState).toHaveBeenNthCalledWith(2, false);
  });

  test('rejects unexpected arguments without publishing', async () => {
    const setLightState = mock(async (_on: boolean) => undefined);
    const configuration = createSyntheticConfiguration({ ownerUserId: 'owner-user', setLightState });
    const toggle = configuration.functions['lighting.toggle']!;

    await expect(toggle({
      source: {
        kind: 'user',
        id: 'owner-user',
        sessionId: 1,
        coordinatorName: null,
        verifiedEmail: null,
      },
      arguments: true,
      idempotencyKey: null,
      signal: new AbortController().signal,
      emit: async () => undefined,
    })).rejects.toMatchObject({ code: 2001, retryable: false });
    expect(setLightState).not.toHaveBeenCalled();
  });
});
