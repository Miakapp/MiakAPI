import { describe, expect, test } from 'bun:test';

import {
  APP_ABI,
  MiakappUnavailableError,
  callErrorCode,
  connect,
  type HomeState,
  type MiakappHost,
} from '../src/index.js';

/** A stand-in for the object the trusted shell's bootstrap installs. */
function fakeHost(values: Record<string, unknown>, stale = false) {
  let state: HomeState = { values, revision: 1, stale };
  const listeners = new Set<(state: HomeState) => void>();
  const calls: Array<{ name: string; args: unknown }> = [];
  let ready = 0;
  const host: MiakappHost = {
    abi: APP_ABI,
    release: 'r1',
    home: { id: 'maison-a', name: 'Maison A' },
    locale: 'fr',
    theme: 'dark',
    onThemeChange: () => () => undefined,
    state: {
      get: (path) => state.values[path],
      values: () => state.values,
      get revision() {
        return state.revision;
      },
      get stale() {
        return state.stale;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    can: {
      read: (path) => path.startsWith('room.'),
      call: (name) => name === 'lighting.set',
    },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name !== 'lighting.set') throw Object.assign(new Error('x'), { code: 'denied' });
      return { applied: true };
    },
    ready: () => {
      ready += 1;
    },
  };
  return {
    host,
    calls,
    readyCount: () => ready,
    emit(next: HomeState) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('@miakapp/app', () => {
  test('connects only inside a house frame', () => {
    expect(() => connect({})).toThrow(MiakappUnavailableError);
    expect(() => connect({ miakapp: { abi: 'miakapp.component/1' } })).toThrow(MiakappUnavailableError);
  });

  test('exposes the granted view, its paths and staleness', () => {
    const reading = { kind: 'temperature', value: 21.5, unit: '°C', fresh: true };
    const fake = fakeHost({ 'room.kitchen.temperature': reading, 'room.kitchen.humidity': 48, 'security.doors.front': false });
    const home = connect({ miakapp: fake.host });
    expect(home.name).toBe('Maison A');
    expect(home.theme()).toBe('dark');
    expect(home.get<typeof reading>('room.kitchen.temperature')).toEqual(reading);
    expect(home.paths('room')).toEqual(['room.kitchen.humidity', 'room.kitchen.temperature']);
    expect(home.paths('room.sal')).toEqual([]);
    expect(home.canRead('security.doors.front')).toBe(false);

    const seen: HomeState[] = [];
    const stop = home.subscribe((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    fake.emit({ values: {}, revision: 2, stale: true });
    expect(seen[1]).toEqual({ values: {}, revision: 2, stale: true });
    stop();
    fake.emit({ values: {}, revision: 3, stale: false });
    expect(seen).toHaveLength(2);
  });

  test('calls through the shell and reports the closed failure reason', async () => {
    const fake = fakeHost({});
    const home = connect({ miakapp: fake.host });
    await expect(home.call('lighting.set', { on: true })).resolves.toEqual({ applied: true });
    const failure = await home.call('door.unlock').catch((error: unknown) => error);
    expect(callErrorCode(failure)).toBe('denied');
    expect(callErrorCode(new Error('plain'))).toBeUndefined();
    expect(fake.calls).toEqual([
      { name: 'lighting.set', args: { on: true } },
      { name: 'door.unlock', args: null },
    ]);
    home.ready();
    expect(fake.readyCount()).toBe(1);
  });
});
