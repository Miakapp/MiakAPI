import { describe, expect, test } from 'bun:test';
import { ApplicationCallError, type IncomingCall, type ProtocolValue } from 'miakapi';
import { EVENT_LIGHT_CHANGED, STATE, createHomeConfiguration } from '../coordinator/home.js';

const OWNER = 'owner-uid';

function call(source: Partial<IncomingCall['source']>, args: ProtocolValue): IncomingCall {
  return {
    source: {
      kind: 'user',
      id: OWNER,
      sessionId: 1,
      coordinatorName: null,
      verifiedEmail: null,
      ...source,
    },
    arguments: args,
    idempotencyKey: null,
    signal: new AbortController().signal,
    emit: async () => undefined,
  };
}

function home(overrides: { setLight?: (on: boolean) => Promise<void> } = {}): {
  configuration: ReturnType<typeof createHomeConfiguration>;
  lamp: boolean[];
  published: boolean[];
} {
  const lamp: boolean[] = [];
  const published: boolean[] = [];
  const configuration = createHomeConfiguration({
    ownerUserId: OWNER,
    setLight: overrides.setLight ?? (async (on) => void lamp.push(on)),
    onLightChanged: async (on) => void published.push(on),
  });
  return { configuration, lamp, published };
}

describe('declarations', () => {
  test('the component requirements stay inside what the coordinator grants', () => {
    const { configuration } = home();
    const granted = configuration.stateAccess[0]?.patterns ?? [];

    // Mirrors miakapp.yaml requires.state_read. If one moves, this test fails
    // before the relay silently withholds a path the interface expects.
    const required = [
      'climate.salon.temperature',
      'service.coordinator.health',
      'zone.salon.light.on',
    ];
    for (const path of required) {
      const covered = granted.some((pattern) => pattern.endsWith('.*')
        ? path.startsWith(pattern.slice(0, -1))
        : pattern === path);
      expect(covered).toBe(true);
    }
  });

  test('the declared state covers every path the interface reads', () => {
    const { configuration } = home();
    expect(Object.keys(configuration.state).sort()).toEqual(
      [STATE.health, STATE.lightOn, STATE.temperature].sort(),
    );
  });

  test('the light event is published to users and subscribed by the owner', () => {
    const { configuration } = home();
    expect(configuration.events).toEqual([
      { topic: EVENT_LIGHT_CHANGED, directions: 0x02 },
    ]);
    expect(configuration.eventAccess[0]?.subscribe).toEqual([EVENT_LIGHT_CHANGED]);
    expect(configuration.eventAccess[0]?.publish).toEqual([]);
  });
});

describe('lighting.set', () => {
  function handler(configuration: ReturnType<typeof createHomeConfiguration>) {
    const fn = configuration.functions['lighting.set'];
    if (fn === undefined) throw new Error('lighting.set is not declared');
    return fn;
  }

  test('drives the lamp and reports the new value', async () => {
    const { configuration, lamp, published } = home();
    const result = await handler(configuration)(call({}, { on: true }));
    expect(result).toEqual({ on: true });
    expect(lamp).toEqual([true]);
    expect(published).toEqual([true]);
  });

  test('refuses a caller who is not the owner', async () => {
    const { configuration, lamp } = home();
    await expect(handler(configuration)(call({ id: 'someone-else' }, { on: true })))
      .rejects.toBeInstanceOf(ApplicationCallError);
    expect(lamp).toEqual([]);
  });

  test('refuses a coordinator-originated call', async () => {
    const { configuration, lamp } = home();
    await expect(handler(configuration)(
      call({ kind: 'coordinator', coordinatorName: 'other' }, { on: true }),
    )).rejects.toBeInstanceOf(ApplicationCallError);
    expect(lamp).toEqual([]);
  });

  test('refuses a malformed argument before touching the hardware', async () => {
    const { configuration, lamp } = home();
    await expect(handler(configuration)(call({}, { on: 'yes' })))
      .rejects.toBeInstanceOf(ApplicationCallError);
    await expect(handler(configuration)(call({}, null)))
      .rejects.toBeInstanceOf(ApplicationCallError);
    expect(lamp).toEqual([]);
  });

  test('a hardware failure is not reported as success', async () => {
    const { configuration, published } = home({
      setLight: async () => {
        throw new Error('the lamp did not answer');
      },
    });
    await expect(handler(configuration)(call({}, { on: true }))).rejects.toThrow(/did not answer/);
    expect(published).toEqual([]);
  });
});
