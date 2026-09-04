import type {
  BrowserCoordinatorStatus,
  BrowserHomeStatus,
  BrowserReadySession,
} from '../browser-api.js';
import {
  LIMITS,
  Opcode,
  type Frame,
  type ProtocolValue,
} from '../protocol/codec.js';
import { UserProtocolSession } from '../protocol/user-session.js';
import { BrowserClientError, browserProtocolFailure } from './browser-errors.js';
import { childAbortController, createDeferred } from './resources.js';
import type {
  BrowserRuntime,
  ManagedSocket,
  SocketHandlers,
} from './runtime.js';

export interface UserRelayLimits {
  readonly frameBytes: number;
  readonly inflightCalls: number;
  readonly subscriptions: number;
  readonly queuedBytes: number;
}

export interface UserRelayWelcome {
  readonly readySession: BrowserReadySession;
  readonly epoch: Uint8Array;
  readonly expiresAtMs: number;
  readonly limits: UserRelayLimits;
}

export interface UserRelaySessionCallbacks {
  frame(frame: Frame): void;
  closed(code: number, reason: string): void;
  failed(error: Error): void;
}

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 0;
const HANDSHAKE_TIMEOUT_MS = 10_000;

function integer(value: ProtocolValue | undefined, label: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw browserProtocolFailure(`${label} is invalid`);
  }
  return value;
}

function array(value: ProtocolValue | undefined, label: string): ProtocolValue[] {
  if (!Array.isArray(value)) throw browserProtocolFailure(`${label} is not an array`);
  return value;
}

function bytes(value: ProtocolValue | undefined, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16) {
    throw browserProtocolFailure(`${label} is invalid`);
  }
  return value.slice();
}

function coordinatorStatuses(value: ProtocolValue | undefined): readonly BrowserCoordinatorStatus[] {
  return Object.freeze(array(value, 'WELCOME.coordinators').map((raw, index) => {
    const fields = array(raw, `WELCOME.coordinators[${index}]`);
    const name = fields[0];
    const rawStatus = fields[2];
    if (typeof name !== 'string' || (rawStatus !== 1 && rawStatus !== 2)) {
      throw browserProtocolFailure(`WELCOME.coordinators[${index}] is invalid`);
    }
    return Object.freeze({
      name,
      generation: integer(fields[1], `WELCOME.coordinators[${index}].generation`),
      status: rawStatus === 1 ? 'connected' as const : 'grace' as const,
    });
  }));
}

export function parseUserHomeStatus(
  enrolledValue: ProtocolValue | undefined,
  coordinatorsValue: ProtocolValue | undefined,
  stale: boolean,
): BrowserHomeStatus {
  if (typeof enrolledValue !== 'boolean') {
    throw browserProtocolFailure('HOME_STATUS.enrolled is invalid');
  }
  return Object.freeze({
    enrolled: enrolledValue,
    coordinators: coordinatorStatuses(coordinatorsValue),
    stale,
  });
}

function parseWelcome(frame: Frame, connectedAtMs: number, receivedAtMs: number): UserRelayWelcome {
  if (frame.opcode !== Opcode.Welcome) throw browserProtocolFailure('Expected WELCOME');
  const major = integer(frame.payload[0], 'WELCOME.major', 0);
  const minor = integer(frame.payload[1], 'WELCOME.minor', 0);
  if (major !== PROTOCOL_MAJOR || minor !== PROTOCOL_MINOR) {
    throw browserProtocolFailure('WELCOME selected an unsupported protocol version');
  }
  const home = parseUserHomeStatus(frame.payload[4], frame.payload[5], false);
  const limits = array(frame.payload[6], 'WELCOME.limits');
  const frameBytes = integer(limits[0], 'WELCOME.maxFrameBytes');
  const inflightCalls = integer(limits[1], 'WELCOME.maxInflightCalls');
  const subscriptions = integer(limits[2], 'WELCOME.maxSubscriptions');
  const queuedBytes = integer(limits[3], 'WELCOME.maxQueuedBytes');
  if (frameBytes > LIMITS.frameBytes
    || inflightCalls > LIMITS.inflightCalls
    || subscriptions > LIMITS.subscriptions
    || queuedBytes > 1_048_576) {
    throw browserProtocolFailure('WELCOME limits exceed the protocol maxima');
  }
  const expiresAtMs = integer(frame.payload[7], 'WELCOME.expiresAtMs');
  if (expiresAtMs <= receivedAtMs) throw browserProtocolFailure('WELCOME expiry is not in the future');
  return Object.freeze({
    readySession: Object.freeze({
      sessionId: integer(frame.payload[2], 'WELCOME.sessionId'),
      connectedAtMs,
      enrolled: home.enrolled,
      coordinators: home.coordinators,
    }),
    epoch: bytes(frame.payload[3], 'WELCOME.epoch'),
    expiresAtMs,
    limits: Object.freeze({ frameBytes, inflightCalls, subscriptions, queuedBytes }),
  });
}

export class UserRelaySession {
  readonly #callbacks: UserRelaySessionCallbacks;
  readonly #now: () => number;
  readonly #protocol = new UserProtocolSession();
  readonly #welcome = createDeferred<UserRelayWelcome>();
  readonly #queuedFrames: Frame[] = [];
  #queuedFrameBytes = 0;
  #socket: ManagedSocket | undefined;
  #closed = false;
  #connectedAtMs = 0;
  #welcomeValue: UserRelayWelcome | undefined;
  #deliverFrames = false;

  private constructor(callbacks: UserRelaySessionCallbacks, now: () => number) {
    this.#callbacks = callbacks;
    this.#now = now;
    void this.#welcome.promise.catch(() => undefined);
  }

  static async connect(
    runtime: BrowserRuntime,
    homeId: string,
    relayUrl: string,
    token: string,
    signal: AbortSignal,
    callbacks: UserRelaySessionCallbacks,
  ): Promise<UserRelaySession> {
    const session = new UserRelaySession(callbacks, () => runtime.now());
    const handshake = childAbortController(signal);
    const timeout = runtime.setTimer(() => {
      handshake.controller.abort(new Error('Browser relay handshake timed out'));
    }, HANDSHAKE_TIMEOUT_MS);
    const handlers: SocketHandlers = {
      message: (value) => session.#receive(value),
      close: (code, reason) => session.#didClose(code, reason),
      error: (error) => session.#didFail(error),
    };
    try {
      session.#socket = await runtime.socketFactory.connect(
        relayUrl,
        handlers,
        handshake.controller.signal,
      );
      session.#connectedAtMs = runtime.now();
      await session.#socket.write(session.#protocol.encode({
        opcode: Opcode.Hello,
        payload: [1, 0, 0, 1, token, [homeId]],
      }));
      await session.#welcome.promise;
      return session;
    } catch (error) {
      session.terminate();
      session.detach();
      throw error;
    } finally {
      timeout.cancel();
      handshake.dispose();
    }
  }

  get welcome(): UserRelayWelcome {
    if (this.#welcomeValue === undefined) throw new Error('User relay session is not authenticated');
    return this.#welcomeValue;
  }

  get bufferedBytes(): number {
    return this.#socket?.bufferedBytes ?? 0;
  }

  async send(frame: Frame): Promise<void> {
    if (this.#closed || this.#socket === undefined) throw new Error('User relay session is closed');
    if (this.#socket.bufferedBytes > this.welcome.limits.queuedBytes) {
      throw new RangeError('User relay session outbound queue limit exceeded');
    }
    const encoded = this.#protocol.encode(frame);
    if (encoded.byteLength > this.welcome.limits.frameBytes
      || this.#socket.bufferedBytes + encoded.byteLength > this.welcome.limits.queuedBytes) {
      throw new RangeError('User relay session outbound queue limit exceeded');
    }
    await this.#socket.write(encoded);
  }

  startDelivery(): void {
    if (this.#deliverFrames) return;
    this.#deliverFrames = true;
    this.#queuedFrameBytes = 0;
    for (const frame of this.#queuedFrames.splice(0)) {
      if (this.#closed) break;
      this.#callbacks.frame(frame);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#protocol.close();
    this.#socket?.close();
  }

  terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#protocol.close();
    this.#socket?.terminate();
  }

  detach(): void {
    this.#socket?.detach();
  }

  #receive(value: Uint8Array): void {
    if (this.#closed) return;
    try {
      const frame = this.#protocol.decode(value);
      if (frame.opcode === Opcode.Welcome) {
        if (this.#welcomeValue !== undefined) throw browserProtocolFailure('Relay sent WELCOME twice');
        this.#welcomeValue = parseWelcome(frame, this.#connectedAtMs, this.#now());
        this.#welcome.resolve(this.#welcomeValue);
      } else if (!this.#welcome.settled && frame.opcode === Opcode.Fatal) {
        this.#callbacks.frame(frame);
        this.#welcome.reject(browserProtocolFailure('Relay sent FATAL before WELCOME'));
        this.terminate();
      } else if (this.#deliverFrames) {
        this.#callbacks.frame(frame);
      } else {
        this.#queuedFrameBytes += value.byteLength;
        if (this.#queuedFrames.length >= 256
          || this.#queuedFrameBytes > this.welcome.limits.queuedBytes) {
          throw browserProtocolFailure('Relay sent too many frames before session activation');
        }
        this.#queuedFrames.push(frame);
      }
    } catch (error) {
      const failure = error instanceof BrowserClientError ? error : browserProtocolFailure();
      this.#welcome.reject(failure);
      this.#callbacks.failed(failure);
      this.terminate();
    }
  }

  #didClose(code: number, reason: string): void {
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#protocol.close();
    this.#welcome.reject(browserProtocolFailure('Relay closed before WELCOME'));
    if (!wasClosed) this.#callbacks.closed(code, reason);
  }

  #didFail(error: Error): void {
    if (this.#closed) return;
    this.#welcome.reject(error);
    this.#callbacks.failed(error);
    this.terminate();
  }
}
