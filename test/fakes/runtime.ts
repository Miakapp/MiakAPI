import type {
  CoordinatorRuntime,
  RuntimeTimer,
  SocketFactory,
} from '../../src/internal/runtime.js';

interface ScheduledTimer {
  id: number;
  dueAtMs: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeTimer implements RuntimeTimer {
  readonly #timer: ScheduledTimer;

  constructor(timer: ScheduledTimer) {
    this.#timer = timer;
  }

  cancel(): void {
    this.#timer.cancelled = true;
  }
}

export class FakeRuntime implements CoordinatorRuntime {
  readonly socketFactory: SocketFactory;
  readonly #timers: ScheduledTimer[] = [];
  readonly #randomValues: number[] = [];
  #currentTimeMs: number;
  #nextTimerId = 1;

  constructor(socketFactory: SocketFactory, currentTimeMs = 1_000_000) {
    this.socketFactory = socketFactory;
    this.#currentTimeMs = currentTimeMs;
  }

  now(): number {
    return this.#currentTimeMs;
  }

  random(): number {
    return this.#randomValues.shift() ?? 0;
  }

  queueRandom(...values: number[]): void {
    for (const value of values) {
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError('Fake random values must be in [0, 1)');
      }
      this.#randomValues.push(value);
    }
  }

  setTimer(callback: () => void, delayMs: number): RuntimeTimer {
    const timer: ScheduledTimer = {
      id: this.#nextTimerId,
      dueAtMs: this.#currentTimeMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.#nextTimerId += 1;
    this.#timers.push(timer);
    return new FakeTimer(timer);
  }

  get pendingTimerCount(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  async advanceBy(delayMs: number): Promise<void> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new RangeError('Fake time advance must be a non-negative safe integer');
    }
    const targetTimeMs = this.#currentTimeMs + delayMs;
    while (true) {
      const timer = this.#nextDueTimer(targetTimeMs);
      if (timer === undefined) break;
      timer.cancelled = true;
      this.#currentTimeMs = timer.dueAtMs;
      timer.callback();
      await flushMicrotasks();
    }
    this.#currentTimeMs = targetTimeMs;
    await flushMicrotasks();
  }

  #nextDueTimer(targetTimeMs: number): ScheduledTimer | undefined {
    let next: ScheduledTimer | undefined;
    for (const timer of this.#timers) {
      if (timer.cancelled || timer.dueAtMs > targetTimeMs) continue;
      if (next === undefined
        || timer.dueAtMs < next.dueAtMs
        || (timer.dueAtMs === next.dueAtMs && timer.id < next.id)) {
        next = timer;
      }
    }
    return next;
  }
}

export async function flushMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}
