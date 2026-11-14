import { describe, expect, test } from 'bun:test';

import { serveLocal } from '../src/local.js';

describe('serveLocal', () => {
  test('serves the app, streams state and runs calls without the relay', async () => {
    let on = false;
    const local = await serveLocal({
      home: { id: 'test-home', name: 'Test' },
      artifact: new TextEncoder().encode('window.loaded = true;'),
      state: { 'lamp.on': on },
      functions: {
        'lamp.toggle': () => {
          on = !on;
          local.set({ 'lamp.on': on });
          return { on };
        },
      },
      port: 18787,
      host: '127.0.0.1',
      token: 'secret',
    });
    try {
      const base = 'http://127.0.0.1:18787';
      expect((await fetch(`${base}/`)).status).toBe(401);
      expect(await (await fetch(`${base}/?key=secret`)).text()).toContain('window.miakapp');
      expect(await (await fetch(`${base}/app.js?key=secret`)).text()).toBe('window.loaded = true;');
      const call = (name: string) => fetch(`${base}/call?key=secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args: null }),
      });
      expect(await (await call('lamp.toggle')).json()).toEqual({ result: { on: true } });
      expect((await call('unknown')).status).toBe(403);
      const events = await fetch(`${base}/events?key=secret`);
      const reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"lamp.on":true}\n\n');
      await reader.cancel();
    } finally {
      await local.close();
    }
  });
});
