import assert from 'node:assert/strict';
import {
  ApplicationCallError,
  EventDirection,
  createCoordinator,
} from '../dist/index.js';

assert.equal(typeof createCoordinator, 'function');
assert.equal(EventDirection.publishToUsers, 0x02);
assert.equal(new ApplicationCallError(2000, 'Expected').code, 2000);

const coordinator = createCoordinator({
  name: 'node-smoke',
  accessTokenProvider: {
    async getAccessToken() {
      throw new Error('The inert smoke test must not request a token');
    },
  },
});

assert.equal(coordinator.status, 'idle');
coordinator.configure({
  state: {},
  stateAccess: [],
  events: [],
  eventAccess: [],
  functions: {},
});
assert.equal(coordinator.status, 'idle');
const offlineCall = coordinator.calls.start({
  function: 'smoke.missing',
  arguments: null,
  timeoutMs: 1_000,
});
await offlineCall.result.catch(() => undefined);
await new Promise((resolve) => setImmediate(resolve));
await coordinator.stop();
assert.equal(coordinator.status, 'stopped');

console.log(JSON.stringify({ package: 'miakapi', status: 'ok' }));
