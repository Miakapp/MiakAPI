import { describe, expect, test } from 'bun:test';
import {
  ApplicationCallError,
  EventDirection,
} from '../src/api.js';
import * as entrypoint from '../src/index.js';
import {
  validateCoordinatorOptions,
  validateFunctions,
  validateProtocolValue,
  validateStateAccess,
  validateStateEntries,
  validateStateMutations,
} from '../src/internal/validation.js';
import { configuration, createTestHarness, isCoordinatorFailure } from './helpers.js';

describe('public API', () => {
  test('exports the canonical surface and the coordinator factory', () => {
    expect(typeof entrypoint.createCoordinator).toBe('function');
    expect(entrypoint.ApplicationCallError).toBe(ApplicationCallError);
    expect(entrypoint.EventDirection).toBe(EventDirection);
  });

  test('construction and configuration are inert', () => {
    const harness = createTestHarness();
    expect(harness.coordinator.status).toBe('idle');
    expect(harness.relay.connections).toHaveLength(0);
    expect(harness.runtime.pendingTimerCount).toBe(0);

    harness.coordinator.configure(configuration());
    expect(harness.coordinator.status).toBe('idle');
    expect(harness.relay.connections).toHaveLength(0);
    expect(harness.runtime.pendingTimerCount).toBe(0);
  });

  test('rejects invalid and open coordinator option shapes', () => {
    expect(() => validateCoordinatorOptions({
      name: 'valid',
      accessTokenProvider: { async getAccessToken() {} },
      secret: 'must-not-be-accepted',
    })).toThrow(/invalid shape/);
    expect(() => validateCoordinatorOptions({
      name: '../invalid',
      accessTokenProvider: { async getAccessToken() {} },
    })).toThrow(/invalid/);
  });

  test('accepts class-based token providers and loggers', () => {
    class TokenProvider {
      async getAccessToken() {
        return {
          relayUrl: 'wss://relay.test/miakapp/ws',
          token: 'token',
          expiresAtMs: 2_000_000,
        };
      }
    }
    class Logger {
      write(): void {}
    }

    const provider = new TokenProvider();
    const logger = new Logger();
    const options = validateCoordinatorOptions({
      name: 'class-based',
      accessTokenProvider: provider,
      logger,
    });
    expect(options.accessTokenProvider).toBe(provider);
    expect(options.logger).toBe(logger);
  });

  test('ApplicationCallError enforces the application code and safe UTF-8 message ranges', () => {
    const error = new ApplicationCallError(2_000, 'Device rejected the command', true);
    expect(error.code).toBe(2_000);
    expect(error.retryable).toBe(true);
    expect(() => new ApplicationCallError(1_999)).toThrow(RangeError);
    expect(() => new ApplicationCallError(3_000)).toThrow(RangeError);
    expect(() => new ApplicationCallError(2_000, '\ud800')).toThrow(TypeError);
    expect(() => new ApplicationCallError(2_000, 'line\nbreak')).toThrow(TypeError);
  });

  test('protocol values are defensively cloned, frozen, and cycle checked', () => {
    const binary = new Uint8Array([1, 2, 3]);
    const sourceNested: unknown[] = [binary, { ok: true }];
    const source: Record<string, unknown> = { nested: sourceNested };
    const validated = validateProtocolValue(source);
    binary[0] = 9;
    sourceNested.push('late mutation');

    expect(Object.isFrozen(validated)).toBe(true);
    if (validated === null
      || validated instanceof Uint8Array
      || Array.isArray(validated)
      || typeof validated !== 'object') {
      throw new Error('Expected a validated protocol object');
    }
    const nested = validated.nested;
    if (!Array.isArray(nested) || !(nested[0] instanceof Uint8Array)) {
      throw new Error('Expected the cloned nested binary value');
    }
    expect([...nested[0]]).toEqual([1, 2, 3]);
    expect(nested).toHaveLength(2);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateProtocolValue(cyclic)).toThrow(/cycle/);
  });

  test('preserves own prototype-named declarations without prototype mutation', () => {
    const state: Record<string, unknown> = Object.create(null);
    Object.defineProperty(state, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 42,
      writable: true,
    });
    const functions: Record<string, unknown> = Object.create(null);
    const handler = () => 42;
    Object.defineProperty(functions, '__proto__', {
      configurable: true,
      enumerable: true,
      value: handler,
      writable: true,
    });

    const validatedState = validateStateEntries(state);
    const validatedFunctions = validateFunctions(functions);
    expect(Object.getPrototypeOf(validatedState)).toBeNull();
    expect(Object.getPrototypeOf(validatedFunctions)).toBeNull();
    expect(Object.hasOwn(validatedState, '__proto__')).toBe(true);
    expect(validatedState.__proto__).toBe(42);
    expect(validatedFunctions.__proto__).toBe(handler);
  });

  test('bounds aggregate state value bytes before transport encoding', () => {
    const first = new Uint8Array(131_072);
    const second = new Uint8Array(131_072);
    expect(() => validateStateEntries({ first, second })).toThrow(/aggregate value byte limit/);
    expect(() => validateStateMutations([
      { path: 'first', value: first },
      { path: 'second', value: second },
    ])).toThrow(/aggregate value byte limit/);
  });

  test('bounds aggregate ACL bytes before constructing a declaration frame', () => {
    const patterns = Array.from({ length: 1_024 }, (_, index) => {
      const prefix = `root.${index}.`;
      return `${prefix}${'x'.repeat(256 - prefix.length)}`;
    });
    expect(() => validateStateAccess([
      { userId: 'user-1', patterns },
      { userId: 'user-2', patterns },
    ])).toThrow(/aggregate value byte limit/);
  });

  test('offline operations fail closed without creating transport resources', async () => {
    const harness = createTestHarness();
    const stateFailure = await harness.coordinator.state.set([
      { path: 'home.temperature', value: 21 },
    ]).catch((error: unknown) => error);
    const eventFailure = await harness.coordinator.events.publish('home.alert', true).sent
      .catch((error: unknown) => error);
    const call = harness.coordinator.calls.start({
      function: 'home.echo',
      arguments: null,
      timeoutMs: 1_000,
    });
    const acceptedFailure = await call.accepted.catch((error: unknown) => error);
    const resultFailure = await call.result.catch((error: unknown) => error);

    expect(isCoordinatorFailure(stateFailure) && stateFailure.outcome).toBe('not_dispatched');
    expect(isCoordinatorFailure(eventFailure) && eventFailure.outcome).toBe('not_dispatched');
    expect(isCoordinatorFailure(acceptedFailure) && acceptedFailure.outcome).toBe('not_dispatched');
    expect(isCoordinatorFailure(resultFailure) && resultFailure.outcome).toBe('not_dispatched');
    expect(harness.relay.connections).toHaveLength(0);
    expect(harness.runtime.pendingTimerCount).toBe(0);
  });
});
