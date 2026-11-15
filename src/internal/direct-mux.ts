/**
 * Several coordinators, reached directly: one DataChannel per coordinator,
 * aggregated in the browser the way the relay aggregates them. To the browser
 * client this is one relay socket: one WELCOME listing every coordinator, one
 * state dictionary, one function dictionary. Names are unique across a home's
 * coordinators (the relay refuses collisions), so ids are allocated per name
 * here and each call is routed to the coordinator that declared its function.
 *
 * The HELLO token is a JSON object of local tickets by coordinator name.
 */
import { decodeFrame, encodeFrame, LIMITS, Opcode, type Frame, type ProtocolValue } from '../protocol/codec.js';
import { openDirectSocket, type DirectCoordinates } from './direct-socket.js';
import type { ManagedSocket, SocketHandlers } from './runtime.js';

export interface DirectTarget extends DirectCoordinates {
  readonly coordinator: string;
  readonly ticket: string;
  readonly expiresAtMs: number;
}

interface Sub {
  readonly name: string;
  readonly socket: ManagedSocket;
  welcomed: boolean;
  sessionId: number;
  enrolled: boolean;
  expiresAtMs: number;
  limits: number[];
  paths: Map<number, string>;
  functions: Map<number, string>;
  hasState: boolean;
  hasFunctions: boolean;
  resyncing: boolean;
}

const ENCODER = new TextEncoder();

/** Opens every coordinator; all of them, or after `partialAfterMs` whichever answered (at least one). */
export interface DirectMuxOptions {
  /** Function names each coordinator declared last time, so an absent one's calls fail as unavailable. */
  readonly known?: Readonly<Record<string, readonly string[]>>;
  /** A coordinator's functions, as learned from its dictionary. */
  readonly learned?: (coordinator: string, functions: readonly string[]) => void;
  /** How often an absent coordinator is tried again. */
  readonly retryMs?: number;
}

export async function openDirectMux(
  targets: readonly DirectTarget[],
  signal: AbortSignal,
  timeoutMs: number,
  partialAfterMs: number,
  options: DirectMuxOptions = {},
): Promise<DirectMux> {
  const mux = new DirectMux(options, signal, timeoutMs);
  const opened: { target: DirectTarget; socket: ReturnType<typeof mux.bindFor> }[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let lastError: unknown;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(partial);
      if (!ok) {
        reject(lastError ?? new Error('No coordinator answered directly'));
        return;
      }
      const present = new Set(opened.map((entry) => entry.target.coordinator));
      for (const target of targets) if (!present.has(target.coordinator)) mux.markAbsent(target);
      resolve();
    };
    const partial = setTimeout(() => finish(opened.length > 0), Math.min(partialAfterMs, timeoutMs));
    for (const target of targets) {
      openDirectSocket(target, signal, timeoutMs).then((socket) => {
        if (settled) {
          // Late: this coordinator is left out of this session.
          socket.close();
          return;
        }
        opened.push({ target, socket: mux.bindFor(target, socket) });
        if (opened.length === targets.length) finish(true);
      }, (error: unknown) => {
        lastError = error;
        failures += 1;
        if (failures === targets.length) finish(false);
        else if (opened.length + failures === targets.length) finish(opened.length > 0);
      });
    }
  });
  return mux;
}

export class DirectMux implements ManagedSocket {
  readonly #subs = new Map<string, Sub>();
  /** Coordinators of the home not reached (yet): shown in grace, their calls unavailable, retried. */
  readonly #absent = new Map<string, DirectTarget>();
  readonly #options: DirectMuxOptions;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  #retry: ReturnType<typeof setInterval> | undefined;
  #helloContext: ProtocolValue = [];
  #handlers: SocketHandlers | undefined;
  #closed = false;
  #welcomed = false;
  #helloRequestTokens: Record<string, string> = {};
  readonly #epoch = crypto.getRandomValues(new Uint8Array(16));
  #revision = 0;
  readonly #pathIds = new Map<string, number>();
  readonly #functionIds = new Map<string, number>();
  readonly #values = new Map<string, ProtocolValue>();
  readonly #owners = new Map<string, string>();
  readonly #calls = new Map<number, string>();
  readonly #reauths = new Map<number, { pending: Set<string>; expiresAtMs: number }>();

  constructor(options: DirectMuxOptions = {}, signal: AbortSignal = new AbortController().signal, timeoutMs = 4_000) {
    this.#options = options;
    this.#signal = signal;
    this.#timeoutMs = timeoutMs;
  }

  markAbsent(target: DirectTarget): void {
    this.#absent.set(target.coordinator, target);
    for (const name of this.#options.known?.[target.coordinator] ?? []) {
      if (!this.#owners.has(`fn:${name}`)) this.#owners.set(`fn:${name}`, `absent:${target.coordinator}`);
      if (!this.#functionIds.has(name)) this.#functionIds.set(name, this.#functionIds.size + 1);
    }
    this.#retry ??= setInterval(() => this.#retryAbsent(), this.#options.retryMs ?? 15_000);
  }

  get absent(): readonly string[] {
    return [...this.#absent.keys()];
  }

  #retryAbsent(): void {
    if (this.#closed || !this.#welcomed) return;
    for (const target of this.#absent.values()) {
      if (this.#subs.has(target.coordinator)) continue;
      void openDirectSocket(target, this.#signal, this.#timeoutMs).then(async (socket) => {
        if (this.#closed || !this.#absent.has(target.coordinator)) {
          socket.close();
          return;
        }
        const managed = this.bindFor(target, socket);
        await managed.write(encodeFrame({
          opcode: Opcode.Hello,
          payload: [1, 0, 0, 1, this.#helloRequestTokens[target.coordinator] ?? target.ticket, this.#helloContext],
        }));
      }).catch(() => undefined);
    }
  }

  /** A coordinator that came back has synchronized: it leaves grace. */
  #joined(sub: Sub): void {
    if (!this.#absent.delete(sub.name)) return;
    if (this.#absent.size === 0 && this.#retry !== undefined) {
      clearInterval(this.#retry);
      this.#retry = undefined;
    }
    this.#emit({ opcode: Opcode.HomeStatus, payload: [this.#enrolled(), this.#coordinatorList()] });
  }

  #enrolled(): boolean {
    return [...this.#subs.values()].some((sub) => sub.enrolled);
  }

  #coordinatorList(): ProtocolValue[] {
    const entries: [string, number, number][] = [];
    for (const sub of this.#subs.values()) if (sub.welcomed) entries.push([sub.name, 1, 1]);
    for (const name of this.#absent.keys()) if (!entries.some((entry) => entry[0] === name)) entries.push([name, 1, 2]);
    return entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  bindFor(target: DirectTarget, socket: { bind(handlers: SocketHandlers): ManagedSocket }): ManagedSocket {
    const sub: Sub = {
      name: target.coordinator,
      socket: undefined as unknown as ManagedSocket,
      welcomed: false,
      sessionId: 0,
      enrolled: false,
      expiresAtMs: target.expiresAtMs,
      limits: [LIMITS.frameBytes, LIMITS.inflightCalls, LIMITS.subscriptions, 1_048_576],
      paths: new Map(),
      functions: new Map(),
      hasState: false,
      hasFunctions: false,
      resyncing: false,
    };
    const managed = socket.bind({
      message: (bytes) => this.#fromSub(sub, bytes),
      close: (code, reason) => this.#subClosed(sub, target, code, reason),
      error: (error) => this.#handlers?.error(error),
    });
    (sub as { socket: ManagedSocket }).socket = managed;
    this.#subs.set(sub.name, sub);
    return managed;
  }

  #subClosed(sub: Sub, target: DirectTarget, code: number, reason: string): void {
    if (this.#closed || this.#subs.get(sub.name) !== sub) return;
    if (!this.#welcomed) {
      this.#fail(code, reason);
      return;
    }
    // One coordinator went away: the rest of the home stays usable. Its values
    // stay as last seen (like the relay's grace), its calls fail as unavailable.
    this.#subs.delete(sub.name);
    for (const name of sub.functions.values()) {
      if (this.#owners.get(`fn:${name}`) === sub.name) this.#owners.set(`fn:${name}`, `absent:${sub.name}`);
    }
    for (const [callId, owner] of this.#calls) {
      if (owner !== sub.name) continue;
      this.#calls.delete(callId);
      this.#emit({ opcode: Opcode.CallError, payload: [callId, 1404, false, 'The coordinator went away', null] });
    }
    this.markAbsent(target);
    if (this.#subs.size === 0) {
      this.#fail(code, reason);
      return;
    }
    this.#emit({ opcode: Opcode.HomeStatus, payload: [this.#enrolled(), this.#coordinatorList()] });
  }

  bind(handlers: SocketHandlers): this {
    this.#handlers = handlers;
    return this;
  }

  get coordinators(): readonly string[] {
    return [...this.#subs.keys()];
  }

  get bufferedBytes(): number {
    let total = 0;
    for (const sub of this.#subs.values()) total = Math.max(total, sub.socket.bufferedBytes);
    return total;
  }

  // ---- Client → coordinators ----

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('Direct session is closed');
    const frame = decodeFrame(bytes);
    switch (frame.opcode) {
      case Opcode.Hello: {
        const tokens = this.#tokens(frame.payload[4]);
        this.#helloRequestTokens = tokens;
        this.#helloContext = frame.payload[5] as ProtocolValue;
        await Promise.all([...this.#subs.values()].map((sub) => {
          const ticket = tokens[sub.name];
          if (ticket === undefined) throw new Error(`No local ticket for ${sub.name}`);
          return sub.socket.write(encodeFrame({
            opcode: Opcode.Hello,
            payload: [1, 0, 0, 1, ticket, frame.payload[5] as ProtocolValue],
          }));
        }));
        return;
      }
      case Opcode.Reauth: {
        const requestId = frame.payload[0] as number;
        const tokens = this.#tokens(frame.payload[1]);
        this.#reauths.set(requestId, { pending: new Set(this.#subs.keys()), expiresAtMs: Number.MAX_SAFE_INTEGER });
        await Promise.all([...this.#subs.values()].map((sub) => sub.socket.write(encodeFrame({
          opcode: Opcode.Reauth,
          payload: [requestId, tokens[sub.name] ?? this.#helloRequestTokens[sub.name] ?? ''],
        }))));
        return;
      }
      case Opcode.StateResync:
        this.#emitState();
        return;
      case Opcode.Call: {
        const [callId, , , functionId] = frame.payload as [number, number, ProtocolValue, number];
        const name = [...this.#functionIds].find(([, id]) => id === functionId)?.[0];
        const owner = name === undefined ? undefined : this.#owners.get(`fn:${name}`);
        if (owner?.startsWith('absent:') === true) {
          this.#emit({ opcode: Opcode.CallError, payload: [callId, 1401, true, 'The coordinator is not reachable', null] });
          return;
        }
        const sub = owner === undefined ? undefined : this.#subs.get(owner);
        const localId = sub === undefined || name === undefined
          ? undefined
          : [...sub.functions].find(([, fn]) => fn === name)?.[0];
        if (sub === undefined || localId === undefined) {
          this.#emit({ opcode: Opcode.CallError, payload: [callId, 1202, false, 'Function is not declared', null] });
          return;
        }
        this.#calls.set(callId, sub.name);
        const payload = [...frame.payload];
        payload[3] = localId;
        await sub.socket.write(encodeFrame({ opcode: Opcode.Call, payload }));
        return;
      }
      case Opcode.CallCancel: {
        const owner = this.#calls.get(frame.payload[0] as number);
        const sub = owner === undefined ? undefined : this.#subs.get(owner);
        if (sub !== undefined) await sub.socket.write(bytes);
        return;
      }
      case Opcode.CallCredit:
        return;
      default:
        throw new Error('Not served on the direct path');
    }
  }

  #tokens(value: ProtocolValue | undefined): Record<string, string> {
    try {
      const parsed = JSON.parse(String(value)) as unknown;
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, string>;
    } catch { /* not a ticket map */ }
    return {};
  }

  // ---- Coordinators → client ----

  #fromSub(sub: Sub, bytes: Uint8Array): void {
    if (this.#closed) return;
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      this.#fail(1006, 'malformed frame from a coordinator');
      return;
    }
    switch (frame.opcode) {
      case Opcode.Welcome: {
        const [, , sessionId, , enrolled, , limits, expiresAtMs] = frame.payload as [
          number, number, number, Uint8Array, boolean, ProtocolValue, number[], number,
        ];
        sub.welcomed = true;
        sub.sessionId = sessionId;
        sub.enrolled = enrolled;
        sub.limits = limits;
        sub.expiresAtMs = expiresAtMs;
        return;
      }
      case Opcode.Fatal:
        // One coordinator refusing ends the whole direct session: the client
        // reconnects and the relay takes over.
        this.#emit(frame);
        this.#fail(4401, 'a coordinator refused the direct session');
        return;
      case Opcode.StateDict: {
        if (frame.payload[1] === true) {
          for (const name of sub.paths.values()) {
            if (this.#owners.get(name) === sub.name) { this.#owners.delete(name); this.#values.delete(name); }
          }
          sub.paths = new Map();
        }
        for (const [id, name] of frame.payload[2] as [number, string][]) {
          sub.paths.set(id, name);
          this.#owners.set(name, sub.name);
          if (!this.#pathIds.has(name)) this.#pathIds.set(name, this.#pathIds.size + 1);
        }
        sub.resyncing = true;
        return;
      }
      case Opcode.StateSnapshot: {
        for (const [id, value] of frame.payload[2] as [number, ProtocolValue][]) {
          const name = sub.paths.get(id);
          if (name !== undefined) this.#values.set(name, value);
        }
        sub.hasState = true;
        sub.resyncing = false;
        if (sub.hasFunctions) this.#joined(sub);
        this.#maybeWelcome();
        if (this.#welcomed) this.#emitState();
        return;
      }
      case Opcode.StatePatch: {
        if (!this.#welcomed) return;
        const mutations: ProtocolValue[] = [];
        for (const mutation of frame.payload[3] as ProtocolValue[][]) {
          const name = sub.paths.get(mutation[0] as number);
          const id = name === undefined ? undefined : this.#pathIds.get(name);
          if (name === undefined || id === undefined) {
            if (!sub.resyncing) {
              sub.resyncing = true;
              void sub.socket.write(encodeFrame({ opcode: Opcode.StateResync, payload: [1] })).catch(() => undefined);
            }
            return;
          }
          if (mutation[1] === 1) {
            this.#values.delete(name);
            mutations.push([id, 1]);
          } else {
            this.#values.set(name, mutation[2] as ProtocolValue);
            mutations.push([id, 0, mutation[2] as ProtocolValue]);
          }
        }
        if (mutations.length === 0) return;
        const base = this.#revision;
        this.#revision += 1;
        this.#emit({ opcode: Opcode.StatePatch, payload: [this.#epoch, base, this.#revision, mutations] });
        return;
      }
      case Opcode.TopicDict:
        return;
      case Opcode.FunctionDict: {
        for (const [key, owner] of [...this.#owners]) {
          if (key.startsWith('fn:') && (owner === sub.name || owner === `absent:${sub.name}`)) this.#owners.delete(key);
        }
        sub.functions = new Map();
        for (const [id, name] of frame.payload[2] as [number, string][]) {
          sub.functions.set(id, name);
          this.#owners.set(`fn:${name}`, sub.name);
          if (!this.#functionIds.has(name)) this.#functionIds.set(name, this.#functionIds.size + 1);
        }
        sub.hasFunctions = true;
        this.#options.learned?.(sub.name, [...sub.functions.values()]);
        if (sub.hasState) this.#joined(sub);
        this.#maybeWelcome();
        if (this.#welcomed) this.#emitFunctions();
        return;
      }
      case Opcode.ReauthOk: {
        const [requestId, expiresAtMs] = frame.payload as [number, number];
        const pending = this.#reauths.get(requestId);
        if (pending === undefined) return;
        pending.pending.delete(sub.name);
        pending.expiresAtMs = Math.min(pending.expiresAtMs, expiresAtMs);
        if (pending.pending.size === 0) {
          this.#reauths.delete(requestId);
          this.#emit({ opcode: Opcode.ReauthOk, payload: [requestId, pending.expiresAtMs] });
        }
        return;
      }
      case Opcode.CallResult:
      case Opcode.CallError:
        if (frame.payload[1] === true || frame.opcode === Opcode.CallError) this.#calls.delete(frame.payload[0] as number);
        this.#emit(frame);
        return;
      default:
        this.#emit(frame);
    }
  }

  #maybeWelcome(): void {
    if (this.#welcomed) return;
    const subs = [...this.#subs.values()];
    if (subs.length === 0 || !subs.every((sub) => sub.welcomed && sub.hasState && sub.hasFunctions)) return;
    this.#welcomed = true;
    const min = (index: number) => Math.min(...subs.map((sub) => sub.limits[index] as number));
    this.#emit({
      opcode: Opcode.Welcome,
      payload: [
        1, 0, (subs[0] as Sub).sessionId, this.#epoch,
        this.#enrolled(),
        this.#coordinatorList(),
        [min(0), min(1), min(2), min(3)],
        Math.min(...subs.map((sub) => sub.expiresAtMs)),
      ],
    });
    this.#emitState();
    this.#emit({ opcode: Opcode.TopicDict, payload: [this.#epoch, true, []] });
    this.#emitFunctions();
  }

  #emitState(): void {
    if (!this.#welcomed) return;
    const dictionary: [number, string][] = [];
    const values: [number, ProtocolValue][] = [];
    for (const [name, value] of this.#values) {
      const id = this.#pathIds.get(name) as number;
      dictionary.push([id, name]);
      values.push([id, value]);
    }
    dictionary.sort((a, b) => (a[1] < b[1] ? -1 : 1));
    values.sort((a, b) => a[0] - b[0]);
    this.#revision += 1;
    this.#emit({ opcode: Opcode.StateDict, payload: [this.#epoch, true, dictionary] });
    this.#emit({ opcode: Opcode.StateSnapshot, payload: [this.#epoch, this.#revision, values] });
  }

  #emitFunctions(): void {
    const entries: [number, string][] = [];
    for (const [key, owner] of this.#owners) {
      if (!key.startsWith('fn:') || (!this.#subs.has(owner) && !owner.startsWith('absent:'))) continue;
      const name = key.slice(3);
      entries.push([this.#functionIds.get(name) as number, name]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    this.#emit({ opcode: Opcode.FunctionDict, payload: [this.#epoch, true, entries] });
  }

  #emit(frame: Frame): void {
    if (this.#closed) return;
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame);
    } catch {
      this.#fail(1006, 'frame too large');
      return;
    }
    this.#handlers?.message(bytes);
  }

  #fail(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retry !== undefined) clearInterval(this.#retry);
    for (const sub of this.#subs.values()) sub.socket.close();
    this.#handlers?.close(code, reason);
  }

  close(): void {
    this.#fail(1000, 'shutdown');
  }

  terminate(): void {
    this.close();
  }

  detach(): void {
    this.#handlers = undefined;
  }
}

export function ticketToken(targets: readonly DirectTarget[]): string {
  const token = JSON.stringify(Object.fromEntries(targets.map((target) => [target.coordinator, target.ticket])));
  if (ENCODER.encode(token).byteLength > 16_384) throw new Error('Too many coordinators for one direct session');
  return token;
}
