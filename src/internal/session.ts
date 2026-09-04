import type { ReadySession } from '../api.js';
import {
  Opcode,
  type Frame,
  type ProtocolValue,
} from '../protocol/codec.js';
import { CoordinatorProtocolSession } from '../protocol/session.js';
import { CoordinatorError, protocolFailure } from './errors.js';
import { createDeferred } from './resources.js';
import type { CoordinatorRuntime, ManagedSocket, SocketHandlers } from './runtime.js';

export interface RelayLimits {
  frameBytes: number;
  inflightCalls: number;
  subscriptions: number;
  queuedBytes: number;
}

export interface RelayWelcome {
  readySession: ReadySession;
  epoch: Uint8Array;
  expiresAtMs: number;
  limits: RelayLimits;
}

export interface RelaySessionCallbacks {
  frame(frame: Frame): void;
  closed(code: number, reason: string): void;
  failed(error: Error): void;
}

function numberField(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw protocolFailure(`${label} is not an integer`);
  }
  return value;
}

function bytesField(value: ProtocolValue | undefined, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw protocolFailure(`${label} is not binary`);
  return value.slice();
}

function arrayField(value: ProtocolValue | undefined, label: string): ProtocolValue[] {
  if (!Array.isArray(value)) throw protocolFailure(`${label} is not an array`);
  return value;
}

function generationForCoordinator(value: ProtocolValue | undefined, name: string): number {
  const coordinators = arrayField(value, 'WELCOME.coordinators');
  for (const raw of coordinators) {
    const entry = arrayField(raw, 'WELCOME.coordinator');
    if (entry[0] === name) return numberField(entry[1], 'WELCOME.generation');
  }
  throw protocolFailure('WELCOME does not contain the authenticated coordinator');
}

function parseWelcome(
  frame: Frame,
  name: string,
  connectedAtMs: number,
  receivedAtMs: number,
): RelayWelcome {
  if (frame.opcode !== Opcode.Welcome) throw protocolFailure('Expected WELCOME');
  const limits = arrayField(frame.payload[6], 'WELCOME.limits');
  const expiresAtMs = numberField(frame.payload[7], 'WELCOME.expiresAtMs');
  if (expiresAtMs <= receivedAtMs) throw protocolFailure('WELCOME expiry is not in the future');
  return Object.freeze({
    readySession: Object.freeze({
      sessionId: numberField(frame.payload[2], 'WELCOME.sessionId'),
      generation: generationForCoordinator(frame.payload[5], name),
      connectedAtMs,
    }),
    epoch: bytesField(frame.payload[3], 'WELCOME.epoch'),
    expiresAtMs,
    limits: Object.freeze({
      frameBytes: numberField(limits[0], 'WELCOME.maxFrameBytes'),
      inflightCalls: numberField(limits[1], 'WELCOME.maxInflightCalls'),
      subscriptions: numberField(limits[2], 'WELCOME.maxSubscriptions'),
      queuedBytes: numberField(limits[3], 'WELCOME.maxQueuedBytes'),
    }),
  });
}

export class RelaySession {
  readonly #name: string;
  readonly #callbacks: RelaySessionCallbacks;
  readonly #now: () => number;
  readonly #protocol = new CoordinatorProtocolSession();
  readonly #welcome = createDeferred<RelayWelcome>();
  #socket: ManagedSocket | undefined;
  #closed = false;
  #connectedAtMs = 0;
  #welcomeValue: RelayWelcome | undefined;
  #deliverFrames = false;
  #queuedFrameBytes = 0;
  readonly #queuedFrames: Frame[] = [];

  private constructor(
    name: string,
    callbacks: RelaySessionCallbacks,
    now: () => number,
  ) {
    this.#name = name;
    this.#callbacks = callbacks;
    this.#now = now;
  }

  static async connect(
    runtime: CoordinatorRuntime,
    name: string,
    relayUrl: string,
    token: string,
    signal: AbortSignal,
    callbacks: RelaySessionCallbacks,
  ): Promise<RelaySession> {
    const session = new RelaySession(name, callbacks, () => runtime.now());
    const handlers: SocketHandlers = {
      message: (bytes) => session.#receive(bytes),
      close: (code, reason) => session.#didClose(code, reason),
      error: (error) => session.#didFail(error),
    };
    try {
      session.#socket = await runtime.socketFactory.connect(relayUrl, handlers, signal);
      session.#connectedAtMs = runtime.now();
      await session.#socket.write(session.#protocol.encode({
        opcode: Opcode.Hello,
        payload: [1, 0, 0, 2, token, [name]],
      }));
      await session.#welcome.promise;
      return session;
    } catch (error) {
      session.terminate();
      session.detach();
      throw error;
    }
  }

  get welcome(): RelayWelcome {
    if (this.#welcomeValue === undefined) throw new Error('Relay session is not authenticated');
    return this.#welcomeValue;
  }

  get bufferedBytes(): number {
    return this.#socket?.bufferedBytes ?? 0;
  }

  async send(frame: Frame): Promise<void> {
    if (this.#closed || this.#socket === undefined) throw new Error('Relay session is closed');
    if (this.#socket.bufferedBytes > this.welcome.limits.queuedBytes) {
      throw new RangeError('Relay session outbound queue limit exceeded');
    }
    const bytes = this.#protocol.encode(frame);
    if (bytes.byteLength > this.welcome.limits.frameBytes
      || this.#socket.bufferedBytes + bytes.byteLength > this.welcome.limits.queuedBytes) {
      throw new RangeError('Relay session outbound queue limit exceeded');
    }
    await this.#socket.write(bytes);
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

  #receive(bytes: Uint8Array): void {
    if (this.#closed) return;
    try {
      const frame = this.#protocol.decode(bytes);
      if (frame.opcode === Opcode.Welcome) {
        if (this.#welcomeValue !== undefined) throw protocolFailure('Relay sent WELCOME twice');
        this.#welcomeValue = parseWelcome(
          frame,
          this.#name,
          this.#connectedAtMs,
          this.#now(),
        );
        this.#welcome.resolve(this.#welcomeValue);
      } else if (!this.#welcome.settled && frame.opcode === Opcode.Fatal) {
        this.#callbacks.frame(frame);
        if (!this.#welcome.settled) {
          this.#welcome.reject(protocolFailure('Relay sent FATAL before WELCOME'));
        }
        this.terminate();
      } else {
        if (this.#deliverFrames) this.#callbacks.frame(frame);
        else {
          this.#queuedFrameBytes += bytes.byteLength;
          if (this.#queuedFrames.length >= 256
            || this.#queuedFrameBytes > this.welcome.limits.queuedBytes) {
            throw protocolFailure('Relay sent too many frames before session activation');
          }
          this.#queuedFrames.push(frame);
        }
      }
    } catch (error) {
      const failure = error instanceof CoordinatorError ? error : protocolFailure();
      this.#welcome.reject(failure);
      this.#callbacks.failed(failure);
      this.terminate();
    }
  }

  #didClose(code: number, reason: string): void {
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#protocol.close();
    if (!this.#welcome.settled) {
      this.#welcome.reject(new Error('Relay closed before WELCOME'));
    }
    if (!wasClosed) this.#callbacks.closed(code, reason);
  }

  #didFail(error: Error): void {
    if (this.#closed) return;
    this.#welcome.reject(error);
    this.#callbacks.failed(error);
    this.terminate();
  }
}
