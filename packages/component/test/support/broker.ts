import type { GuestBoot, GuestTransport } from '../../src/protocol.js';

export interface SentMessage {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/**
 * A transport double plus the broker-side assertions that actually matter.
 *
 * The real broker in `component-runtime/src/runtime-broker.ts` terminates the
 * instance on a malformed guest message rather than replying, so these checks
 * mirror the ones whose violation would be fatal: the exact `{ v, kind, payload }`
 * envelope, an allowed kind, and a payload free of `undefined`, which is not an
 * allowed structured value.
 */
export class FakeBroker implements GuestTransport {
  readonly sent: SentMessage[] = [];
  #listener: ((data: unknown) => void) | undefined;

  static readonly GUEST_KINDS = new Set([
    'guest.ready',
    'ui.render',
    'event.subscribe',
    'event.unsubscribe',
    'event.publish',
    'call.start',
    'call.credit',
    'call.cancel',
    'log.write',
  ]);

  post(message: unknown): void {
    if (message === null || typeof message !== 'object') {
      throw new Error('guest message must be an object');
    }
    const record = message as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'kind,payload,v') {
      throw new Error(`guest envelope must be exactly {v, kind, payload}, received {${keys}}`);
    }
    if (record['v'] !== 1) throw new Error('guest protocol must be 1');
    const kind = record['kind'];
    if (typeof kind !== 'string' || !FakeBroker.GUEST_KINDS.has(kind)) {
      throw new Error(`guest kind is not allowed: ${String(kind)}`);
    }
    assertStructured(record['payload'], kind);
    this.sent.push({ kind, payload: record['payload'] as Record<string, unknown> });
  }

  subscribe(handler: (data: unknown) => void): void {
    this.#listener = handler;
  }

  /** Delivers one broker-to-guest message in the shape the broker posts. */
  deliver(kind: string, payload: unknown): void {
    if (this.#listener === undefined) throw new Error('the guest did not subscribe');
    this.#listener({ v: 1, kind, payload });
  }

  kinds(): string[] {
    return this.sent.map((message) => message.kind);
  }

  of(kind: string): SentMessage[] {
    return this.sent.filter((message) => message.kind === kind);
  }

  last(kind: string): SentMessage {
    const messages = this.of(kind);
    const message = messages[messages.length - 1];
    if (message === undefined) throw new Error(`no ${kind} message was sent`);
    return message;
  }

  /** Boot, then the first authoritative snapshot, the way the broker sequences them. */
  boot(overrides: Partial<GuestBoot> = {}, values: Record<string, unknown> = {}): void {
    this.deliver('guest.boot', {
      home_id: 'test-home',
      generation: 1,
      release: '2026-09-13.1',
      abi: 'miakapp.component/1',
      grant: {
        state_read: ['climate.*', 'zone.*'],
        event_subscribe: ['zone.*'],
        event_publish: ['zone.*'],
        call: ['lighting.set'],
        presentation: [],
      },
      staging: false,
      locale: 'fr-FR',
      theme: 'system',
      ...overrides,
    });
    this.deliver('state.snapshot', { revision: 1, values });
  }
}

function assertStructured(value: unknown, label: string): void {
  const stack: Array<{ value: unknown; path: string }> = [{ value, path: label }];
  while (stack.length > 0) {
    const item = stack.pop() as { value: unknown; path: string };
    const current = item.value;
    if (current === undefined) {
      throw new Error(`${item.path} is undefined, which is not an allowed structured value`);
    }
    if (current === null || typeof current !== 'object') continue;
    if (current instanceof Uint8Array) continue;
    if (Array.isArray(current)) {
      current.forEach((entry, index) => stack.push({ value: entry, path: `${item.path}[${index}]` }));
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${item.path}.${key} is a forbidden key`);
      }
      stack.push({ value: entry, path: `${item.path}.${key}` });
    }
  }
}
