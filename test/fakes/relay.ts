import {
  decodeFrame,
  encodeFrame,
  Opcode,
  type Frame,
  type ProtocolValue,
} from '../../src/protocol/codec.js';
import type {
  ManagedSocket,
  SocketFactory,
  SocketHandlers,
} from '../../src/internal/runtime.js';
import { createDeferred } from '../../src/internal/resources.js';
import { flushMicrotasks } from './runtime.js';

interface FrameWaiter {
  resolve(frame: Frame): void;
}

export interface FakeRelayOptions {
  autoWelcome?: boolean;
  coordinatorName?: string;
  epoch?: Uint8Array;
  expiresAtMs?: number;
  generation?: number;
  sessionId?: number;
}

export interface DeclarationExchange {
  state: Frame;
  stateAccess: Frame;
  events: Frame;
  eventAccess: Frame;
  functions: Frame;
}

function integer(value: ProtocolValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is not an integer`);
  }
  return value;
}

function entries(value: ProtocolValue | undefined, label: string): ProtocolValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is not an array`);
  return value;
}

function namesFromEntries(frame: Frame, label: string): string[] {
  return entries(frame.payload[1], label).map((raw, index) => {
    const tuple = entries(raw, `${label}[${index}]`);
    const name = tuple[0];
    if (typeof name !== 'string') throw new TypeError(`${label}[${index}] has no name`);
    return name;
  });
}

function functionNames(frame: Frame): string[] {
  return entries(frame.payload[1], 'FUNCTION_SYNC.names').map((value, index) => {
    if (typeof value !== 'string') throw new TypeError(`FUNCTION_SYNC.names[${index}] is invalid`);
    return value;
  });
}

function dictionary(names: readonly string[], firstId: number): ProtocolValue[] {
  return names.map((name, index) => [firstId + index, name]);
}

class FakeManagedSocket implements ManagedSocket {
  readonly #connection: FakeRelayConnection;
  #closed = false;
  #detached = false;
  #bufferedBytes = 0;
  #nextWriteError: Error | undefined;
  #nextWriteCompletion: Promise<void> | undefined;

  constructor(connection: FakeRelayConnection) {
    this.#connection = connection;
  }

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  setBufferedBytes(value: number): void {
    this.#bufferedBytes = value;
  }

  failNextWrite(error = new Error('Synthetic write failure')): void {
    this.#nextWriteError = error;
  }

  deferNextWrite(completion: Promise<void>): void {
    if (this.#nextWriteCompletion !== undefined) {
      throw new Error('A synthetic write is already deferred');
    }
    this.#nextWriteCompletion = completion;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('Synthetic socket is closed');
    const failure = this.#nextWriteError;
    this.#nextWriteError = undefined;
    if (failure !== undefined) throw failure;
    this.#connection.receiveClientBytes(bytes);
    const completion = this.#nextWriteCompletion;
    this.#nextWriteCompletion = undefined;
    await completion;
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#detached) this.#connection.notifyClientClose(code, reason);
  }

  terminate(): void {
    this.close(1006, 'terminated');
  }

  detach(): void {
    this.#detached = true;
  }
}

export class FakeRelayConnection {
  readonly #handlers: SocketHandlers;
  readonly #options: Required<FakeRelayOptions>;
  readonly #onClosed: () => void;
  readonly #frames: Frame[] = [];
  readonly #waiters: FrameWaiter[] = [];
  readonly socket: FakeManagedSocket;
  #serverClosed = false;

  constructor(
    handlers: SocketHandlers,
    options: Required<FakeRelayOptions>,
    onClosed: () => void,
  ) {
    this.#handlers = handlers;
    this.#options = options;
    this.#onClosed = onClosed;
    this.socket = new FakeManagedSocket(this);
  }

  get epoch(): Uint8Array {
    return this.#options.epoch.slice();
  }

  get queuedClientFrameCount(): number {
    return this.#frames.length;
  }

  deferNextClientWrite(): { resolve(): void; reject(error?: Error): void } {
    const completion = createDeferred<void>();
    this.socket.deferNextWrite(completion.promise);
    return {
      resolve: () => completion.resolve(undefined),
      reject: (error = new Error('Synthetic deferred write failure')) => completion.reject(error),
    };
  }

  receiveClientBytes(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#frames.push(frame);
    else waiter.resolve(frame);
    if (frame.opcode === Opcode.Hello && this.#options.autoWelcome) {
      queueMicrotask(() => this.sendWelcome());
    }
  }

  notifyClientClose(_code: number, _reason: string): void {
    this.#markClosed();
  }

  async nextClientFrame(expectedOpcode?: number): Promise<Frame> {
    const frame = this.#frames.shift() ?? await new Promise<Frame>((resolve) => {
      this.#waiters.push({ resolve });
    });
    if (expectedOpcode !== undefined && frame.opcode !== expectedOpcode) {
      throw new Error(
        `Expected client opcode 0x${expectedOpcode.toString(16)}, received 0x${frame.opcode.toString(16)}`,
      );
    }
    return frame;
  }

  send(frame: Frame): void {
    if (this.#serverClosed) throw new Error('Synthetic relay connection is closed');
    this.#handlers.message(encodeFrame(frame));
  }

  sendWelcome(): void {
    this.send({
      opcode: Opcode.Welcome,
      payload: [
        1,
        0,
        this.#options.sessionId,
        this.#options.epoch,
        true,
        [[this.#options.coordinatorName, this.#options.generation, 1]],
        [262_144, 128, 256, 1_048_576],
        this.#options.expiresAtMs,
      ],
    });
  }

  close(code = 1001, reason = 'synthetic disconnect'): void {
    if (this.#serverClosed) return;
    this.#markClosed();
    this.#handlers.close(code, reason);
  }

  fail(error = new Error('Synthetic relay failure')): void {
    if (this.#serverClosed) return;
    this.#markClosed();
    this.#handlers.error(error);
  }

  #markClosed(): void {
    if (this.#serverClosed) return;
    this.#serverClosed = true;
    this.#onClosed();
  }

  async acknowledgeDeclarations(stateFrame?: Frame): Promise<DeclarationExchange> {
    const state = stateFrame ?? await this.nextClientFrame(Opcode.StateSync);
    if (state.opcode !== Opcode.StateSync) {
      throw new Error(`Expected a STATE_SYNC frame, received opcode 0x${state.opcode.toString(16)}`);
    }
    const stateNames = namesFromEntries(state, 'STATE_SYNC.entries');
    this.send({
      opcode: Opcode.StateSyncOk,
      payload: [integer(state.payload[0], 'STATE_SYNC.requestId'), this.epoch, 1, dictionary(stateNames, 101)],
    });

    const stateAccess = await this.nextClientFrame(Opcode.StateAclSync);
    this.send({
      opcode: Opcode.StateAclOk,
      payload: [integer(stateAccess.payload[0], 'STATE_ACL_SYNC.requestId'), 1],
    });

    const events = await this.nextClientFrame(Opcode.EventSync);
    const eventNames = namesFromEntries(events, 'EVENT_SYNC.entries');
    this.send({
      opcode: Opcode.EventSyncOk,
      payload: [integer(events.payload[0], 'EVENT_SYNC.requestId'), dictionary(eventNames, 201)],
    });

    const eventAccess = await this.nextClientFrame(Opcode.EventAclSync);
    this.send({
      opcode: Opcode.EventAclOk,
      payload: [integer(eventAccess.payload[0], 'EVENT_ACL_SYNC.requestId'), 1],
    });

    const functions = await this.nextClientFrame(Opcode.FunctionSync);
    this.send({
      opcode: Opcode.FunctionSyncOk,
      payload: [
        integer(functions.payload[0], 'FUNCTION_SYNC.requestId'),
        dictionary(functionNames(functions), 301),
      ],
    });
    await flushMicrotasks();
    return { state, stateAccess, events, eventAccess, functions };
  }
}

export class FakeRelay implements SocketFactory {
  readonly #options: Required<FakeRelayOptions>;
  readonly #connections: FakeRelayConnection[] = [];
  readonly #connectionWaiters: Array<(connection: FakeRelayConnection) => void> = [];
  readonly #connectErrors: Error[] = [];
  #openConnections = 0;
  #socketHighWater = 0;

  constructor(options: FakeRelayOptions = {}) {
    this.#options = {
      autoWelcome: options.autoWelcome ?? true,
      coordinatorName: options.coordinatorName ?? 'test-coordinator',
      epoch: options.epoch?.slice() ?? new Uint8Array(16).fill(7),
      expiresAtMs: options.expiresAtMs ?? 2_000_000,
      generation: options.generation ?? 4,
      sessionId: options.sessionId ?? 41,
    };
  }

  get connections(): readonly FakeRelayConnection[] {
    return this.#connections;
  }

  get connectCount(): number {
    return this.#connections.length + this.#connectErrors.length;
  }

  get socketHighWater(): number {
    return this.#socketHighWater;
  }

  get openConnectionCount(): number {
    return this.#openConnections;
  }

  queueConnectError(error = new Error('Synthetic connection failure')): void {
    this.#connectErrors.push(error);
  }

  async connect(
    _url: string,
    handlers: SocketHandlers,
    signal: AbortSignal,
  ): Promise<ManagedSocket> {
    if (signal.aborted) throw signal.reason;
    const failure = this.#connectErrors.shift();
    if (failure !== undefined) throw failure;
    const connectionIndex = this.#connections.length;
    const epoch = this.#options.epoch.slice();
    epoch[0] = ((epoch[0] ?? 0) + connectionIndex) % 256;
    const connectionOptions: Required<FakeRelayOptions> = {
      ...this.#options,
      epoch,
      sessionId: this.#options.sessionId + connectionIndex,
    };
    const connection = new FakeRelayConnection(handlers, connectionOptions, () => {
      this.#openConnections -= 1;
    });
    this.#connections.push(connection);
    this.#openConnections += 1;
    this.#socketHighWater = Math.max(this.#socketHighWater, this.#openConnections);
    signal.addEventListener('abort', () => connection.close(1006, 'aborted'), { once: true });
    const waiter = this.#connectionWaiters.shift();
    waiter?.(connection);
    return connection.socket;
  }

  latestConnection(): FakeRelayConnection {
    const connection = this.#connections[this.#connections.length - 1];
    if (connection === undefined) throw new Error('No synthetic relay connection exists');
    return connection;
  }

  async connectionAt(index: number): Promise<FakeRelayConnection> {
    const existing = this.#connections[index];
    if (existing !== undefined) return existing;
    return new Promise<FakeRelayConnection>((resolve) => {
      this.#connectionWaiters.push(resolve);
    });
  }
}
