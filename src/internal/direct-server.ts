/**
 * The coordinator's direct endpoint: residents on the local network open a
 * WebRTC DataChannel straight to this process (no relay, no internet) and
 * speak the user side of RFC 0001, exactly as they would to the relay, for
 * this one coordinator.
 *
 * Authorization is the coordinator's own declarations, applied with the
 * relay's rules: a resident sees the state paths `stateAccess` grants them,
 * and any enrolled resident may call any declared function. A resident proves
 * who they are with a local ticket this coordinator signed for them while the
 * relay vouched for them (the `miakapp.direct.<name>` function), so a session
 * opens without the cloud.
 *
 * Events are not served: the browser client does not use them.
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { ApplicationCallError } from '../api.js';
import type {
  CoordinatorLogger,
  FunctionHandler,
  IncomingCall,
  Principal,
  ProtocolValue,
  StateMutation,
} from '../api.js';
import { decodeFrame, encodeFrame, LIMITS, Opcode, type Frame } from '../protocol/codec.js';
import { issueTicket, loadDirectIdentity, verifyTicket, type DirectIdentity } from './direct-identity.js';

export interface DirectOptions {
  /** Where the certificate, ICE password and ticket key live. Default `.miakapp/direct`. */
  readonly directory?: string;
  /** UDP port. Default 4455. */
  readonly port?: number;
  /** Addresses to publish. Default: this machine's private IPv4 addresses. */
  readonly hosts?: readonly string[];
  /** Local ticket lifetime. Default 30 days. */
  readonly ticketLifetimeMs?: number;
}

export interface DirectCoordinatesRecord {
  readonly v: 1;
  readonly coordinator: string;
  readonly hosts: readonly string[];
  readonly port: number;
  readonly fingerprint: string;
  readonly pwd: string;
  readonly ticket: string;
  readonly expiresAtMs: number;
}

export interface DirectDeclarations {
  /** Bumped by every explicit state declaration, which is authoritative. */
  readonly stateRevision: number;
  readonly state: Readonly<Record<string, ProtocolValue>>;
  readonly stateAccess: readonly {
    readonly userId: string;
    readonly patterns: readonly string[];
    readonly directPatterns?: readonly string[];
  }[];
  readonly eventAccess: readonly { readonly userId: string }[];
  readonly functions: Readonly<Record<string, FunctionHandler>>;
}

export const DIRECT_FUNCTION_PREFIX = 'miakapp.direct.';
const UFRAG_PREFIX = 'mkd1';
const MAX_SESSIONS = 32;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_QUEUED_BYTES = 1_048_576;

interface NdcDataChannel {
  getLabel(): string;
  sendMessageBinary(buffer: Uint8Array): boolean;
  bufferedAmount(): number;
  isOpen(): boolean;
  close(): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
  onClosed(cb: () => void): void;
}

interface NdcPeerConnection {
  onStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (dc: NdcDataChannel) => void): void;
  setRemoteDescription(sdp: string, type: string): void;
  setLocalDescription(type: string, init?: { iceUfrag?: string; icePwd?: string }): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  close(): void;
}

interface NdcModule {
  IceUdpMuxListener: new (port: number, address?: string) => {
    onUnhandledStunRequest(cb: (request: { ufrag: string; localUfrag: string; host: string; port: number }) => void): void;
    stop(): void;
  };
  PeerConnection: new (name: string, config: Record<string, unknown>) => NdcPeerConnection;
}

function privateIPv4(): string[] {
  const found: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    // Container bridges are not reachable from the home network.
    if (/^(docker|br-|veth|cni|flannel|cilium|lxc|virbr)/.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address.address)) {
        found.push(address.address);
      }
    }
  }
  // Home networks first: 192.168.x is the usual LAN, 10.x often a VPN.
  return found.sort((a, b) => Number(!a.startsWith('192.168.')) - Number(!b.startsWith('192.168.'))).slice(0, 8);
}

/**
 * Native objects are never closed from inside one of their own callbacks:
 * libdatachannel aborts the process when a callback thread tears itself down.
 */
function later(close: () => void): void {
  setTimeout(() => {
    try { close(); } catch { /* already closed */ }
  }, 0);
}

function matches(pattern: string, path: string): boolean {
  return pattern.endsWith('.*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
}

function remoteOffer(ufrag: string, pwd: string): string {
  return [
    'v=0', 'o=- 0 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=mid:0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`,
    // The browser's certificate is not known in advance: it is authenticated
    // by its ticket, inside the channel. The browser pins ours.
    `a=fingerprint:sha-256 ${Array(32).fill('00').join(':')}`,
    'a=setup:active', 'a=sctp-port:5000', `a=max-message-size:${LIMITS.frameBytes}`, '',
  ].join('\r\n');
}

export interface DirectServerHost {
  coordinatorName: string;
  logger?: CoordinatorLogger;
  declarations(): DirectDeclarations;
}

export class DirectServer {
  readonly #host: DirectServerHost;
  readonly #identity: DirectIdentity;
  readonly #hosts: readonly string[];
  readonly #port: number;
  readonly #ticketLifetimeMs: number;
  readonly #ndc: NdcModule;
  readonly #listener: { stop(): void };
  readonly #peers = new Map<string, NdcPeerConnection>();
  readonly #sessions = new Set<DirectSession>();
  readonly #keepAlive: ReturnType<typeof setInterval>;
  readonly epoch = randomBytes(16);
  readonly #pathIds = new Map<string, number>();
  readonly #functionIds = new Map<string, number>();
  #values = new Map<string, ProtocolValue>();
  #declarations: DirectDeclarations;
  revision = 1;
  #nextSessionId = 1 + Math.floor(Math.random() * 1_000_000);
  #closed = false;

  private constructor(host: DirectServerHost, ndc: NdcModule, identity: DirectIdentity, options: DirectOptions) {
    this.#host = host;
    this.#ndc = ndc;
    this.#identity = identity;
    this.#port = options.port ?? 4455;
    this.#hosts = Object.freeze([...(options.hosts ?? privateIPv4())]);
    this.#ticketLifetimeMs = options.ticketLifetimeMs ?? 30 * 86_400_000;
    this.#declarations = host.declarations();
    this.#reset();
    const listener = new ndc.IceUdpMuxListener(this.#port, '0.0.0.0');
    listener.onUnhandledStunRequest((request) => this.#accept(request));
    this.#listener = listener;
    // The native listener alone does not keep the process alive.
    this.#keepAlive = setInterval(() => undefined, 3_600_000);
  }

  /** Starts the endpoint, or resolves `undefined` when WebRTC is not available here. */
  static async start(host: DirectServerHost, options: DirectOptions = {}): Promise<DirectServer | undefined> {
    let ndc: NdcModule;
    try {
      const specifier = 'node-datachannel';
      const loaded = await import(specifier) as { default?: NdcModule } & NdcModule;
      ndc = loaded.default ?? loaded;
    } catch {
      host.logger?.write({ level: 'warn', event: 'direct_unavailable_no_webrtc' });
      return undefined;
    }
    try {
      const identity = loadDirectIdentity(options.directory ?? '.miakapp/direct');
      const server = new DirectServer(host, ndc, identity, options);
      host.logger?.write({ level: 'info', event: 'direct_listening' });
      return server;
    } catch {
      host.logger?.write({ level: 'warn', event: 'direct_start_failed' });
      return undefined;
    }
  }

  get hosts(): readonly string[] {
    return this.#hosts;
  }

  /** Coordinates and a fresh ticket for one resident, as vouched for by the relay. */
  coordinatesFor(source: Principal): DirectCoordinatesRecord {
    const expiresAtMs = Date.now() + this.#ticketLifetimeMs;
    return Object.freeze({
      v: 1,
      coordinator: this.#host.coordinatorName,
      hosts: this.#hosts,
      port: this.#port,
      fingerprint: this.#identity.fingerprint,
      pwd: this.#identity.pwd,
      ticket: issueTicket(this.#identity.ticketKey, {
        userId: source.id,
        verifiedEmail: source.verifiedEmail,
        expiresAtMs,
      }),
      expiresAtMs,
    });
  }

  verify(ticket: string): ReturnType<typeof verifyTicket> {
    return verifyTicket(this.#identity.ticketKey, ticket, Date.now());
  }

  // ---- State ----

  #reset(previous?: DirectDeclarations): void {
    const live = this.#values;
    this.#values = new Map(Object.entries(this.#declarations.state));
    // Another domain changed: live values survive, as the relay's acknowledged ones do.
    if (previous !== undefined && previous.stateRevision === this.#declarations.stateRevision) {
      for (const [path, value] of live) if (this.#values.has(path)) this.#values.set(path, value);
      for (const path of this.#values.keys()) if (!live.has(path) && Object.hasOwn(previous.state, path)) this.#values.delete(path);
    }
    for (const path of this.#values.keys()) {
      if (!this.#pathIds.has(path)) this.#pathIds.set(path, this.#pathIds.size + 1);
    }
    for (const name of Object.keys(this.#declarations.functions)) {
      if (!this.#functionIds.has(name)) this.#functionIds.set(name, this.#functionIds.size + 1);
    }
  }

  /** The coordinator's declarations changed: they are authoritative, as on the relay. */
  declarationsChanged(): void {
    const previous = this.#declarations;
    this.#declarations = this.#host.declarations();
    this.#reset(previous);
    this.revision += 1;
    for (const session of this.#sessions) session.bootstrap();
  }

  /** A `state.set` batch: applied here at once, whatever the relay does with it. */
  apply(mutations: readonly StateMutation[]): void {
    const applied: StateMutation[] = [];
    for (const mutation of mutations) {
      if (!this.#pathIds.has(mutation.path)) continue;
      if ('delete' in mutation) this.#values.delete(mutation.path);
      else this.#values.set(mutation.path, mutation.value);
      applied.push(mutation);
    }
    if (applied.length === 0) return;
    const previous = this.revision;
    this.revision += 1;
    for (const session of this.#sessions) session.patch(applied, previous);
  }

  values(): ReadonlyMap<string, ProtocolValue> {
    return this.#values;
  }

  pathId(path: string): number | undefined {
    return this.#pathIds.get(path);
  }

  functionEntries(): [number, string][] {
    return Object.keys(this.#declarations.functions)
      .map((name) => [this.#functionIds.get(name) as number, name] as [number, string])
      .sort((a, b) => a[0] - b[0]);
  }

  functionById(id: number): { name: string; handler: FunctionHandler } | undefined {
    for (const [name, functionId] of this.#functionIds) {
      if (functionId !== id) continue;
      const handler = this.#declarations.functions[name];
      if (handler !== undefined) return { name, handler };
    }
    return undefined;
  }

  visible(userId: string, path: string): boolean {
    for (const entry of this.#declarations.stateAccess) {
      if (entry.userId !== userId) continue;
      if (entry.patterns.some((pattern) => matches(pattern, path))) return true;
      if (entry.directPatterns?.some((pattern) => matches(pattern, path)) === true) return true;
    }
    return false;
  }

  enrolled(userId: string): boolean {
    return this.#declarations.stateAccess.some((entry) => entry.userId === userId)
      || this.#declarations.eventAccess.some((entry) => entry.userId === userId);
  }

  nextSessionId(): number {
    return this.#nextSessionId++;
  }

  get coordinatorName(): string {
    return this.#host.coordinatorName;
  }

  get logger(): CoordinatorLogger | undefined {
    return this.#host.logger;
  }

  // ---- Transport ----

  #accept(request: { ufrag: string; localUfrag: string; host: string; port: number }): void {
    if (this.#closed || !request.localUfrag.startsWith(UFRAG_PREFIX)) return;
    const key = `${request.localUfrag}:${request.ufrag}`;
    if (this.#peers.has(key) || this.#peers.size >= MAX_SESSIONS) return;
    const browserPwd = request.localUfrag.slice(UFRAG_PREFIX.length);
    if (!/^[A-Za-z0-9+/]{22,256}$/.test(browserPwd) || !/^[A-Za-z0-9+/]{4,256}$/.test(request.ufrag)) return;
    let pc: NdcPeerConnection;
    try {
      pc = new this.#ndc.PeerConnection(`direct-${this.#peers.size}`, {
        iceServers: [],
        enableIceUdpMux: true,
        bindAddress: '0.0.0.0',
        portRangeBegin: this.#port,
        portRangeEnd: this.#port,
        disableFingerprintVerification: true,
        disableAutoNegotiation: true,
        certificatePemFile: this.#identity.certificatePath,
        keyPemFile: this.#identity.keyPath,
        maxMessageSize: LIMITS.frameBytes,
      });
    } catch {
      return;
    }
    this.#peers.set(key, pc);
    const timer = setTimeout(() => {
      if (!opened) close();
    }, HANDSHAKE_TIMEOUT_MS * 2);
    let opened = false;
    const close = () => {
      clearTimeout(timer);
      if (this.#peers.get(key) !== pc) return;
      this.#peers.delete(key);
      later(() => pc.close());
    };
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') close();
    });
    pc.onDataChannel((channel) => {
      if (opened) {
        later(() => channel.close());
        return;
      }
      opened = true;
      clearTimeout(timer);
      const session = new DirectSession(this, channel, () => {
        this.#sessions.delete(session);
        close();
      });
      this.#sessions.add(session);
    });
    try {
      pc.setRemoteDescription(remoteOffer(request.ufrag, browserPwd), 'offer');
      pc.setLocalDescription('answer', { iceUfrag: request.localUfrag, icePwd: this.#identity.pwd });
      pc.addRemoteCandidate(`a=candidate:1 1 UDP 2130706431 ${request.host} ${request.port} typ host`, '0');
    } catch {
      close();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepAlive);
    for (const session of this.#sessions) session.close();
    for (const pc of this.#peers.values()) later(() => pc.close());
    this.#peers.clear();
    const listener = this.#listener;
    later(() => listener.stop());
  }
}

interface InboundCall {
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  done: boolean;
}

class DirectSession {
  readonly #server: DirectServer;
  readonly #channel: NdcDataChannel;
  readonly #onClose: () => void;
  readonly #calls = new Map<number, InboundCall>();
  readonly #handshake: ReturnType<typeof setTimeout>;
  #userId: string | undefined;
  #email: string | null = null;
  #sessionId = 0;
  #expiresAtMs = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #lastRevision = 0;
  #closed = false;

  constructor(server: DirectServer, channel: NdcDataChannel, onClose: () => void) {
    this.#server = server;
    this.#channel = channel;
    this.#onClose = onClose;
    this.#handshake = setTimeout(() => this.close(), HANDSHAKE_TIMEOUT_MS);
    channel.onMessage((message) => {
      if (typeof message === 'string') {
        this.#fatal(0, 1000, 'Binary frames only');
        return;
      }
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
      this.#receive(bytes);
    });
    channel.onClosed(() => this.close());
  }

  #send(frame: Frame): void {
    if (this.#closed || !this.#channel.isOpen()) return;
    const bytes = encodeFrame(frame);
    if (this.#channel.bufferedAmount() + bytes.byteLength > MAX_QUEUED_BYTES) {
      // A consumer that cannot keep up is shed, as the relay does.
      this.close();
      return;
    }
    this.#channel.sendMessageBinary(bytes);
  }

  #fatal(sourceOpcode: number, code: number, message: string, retryable = false): void {
    try {
      this.#send({ opcode: Opcode.Fatal, payload: [sourceOpcode, code, retryable, message] });
    } finally {
      setTimeout(() => this.close(), 50);
    }
  }

  #receive(bytes: Uint8Array): void {
    if (this.#closed) return;
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      this.#fatal(0, 1000, 'Malformed frame');
      return;
    }
    try {
      if (this.#userId === undefined) {
        if (frame.opcode !== Opcode.Hello) {
          this.#fatal(frame.opcode, 1001, 'HELLO must come first');
          return;
        }
        this.#hello(frame);
        return;
      }
      switch (frame.opcode) {
        case Opcode.StateResync:
          this.#sendState();
          return;
        case Opcode.Call:
          this.#call(frame);
          return;
        case Opcode.CallCancel:
          this.#cancel(frame);
          return;
        case Opcode.Reauth:
          this.#reauth(frame);
          return;
        case Opcode.CallCredit:
          return;
        default:
          this.#fatal(frame.opcode, 1203, 'Not served on the direct path');
      }
    } catch {
      this.#fatal(frame.opcode, 1500, 'Internal error');
    }
  }

  #hello(frame: Frame): void {
    const [major, minMinor, , role, token] = frame.payload as [number, number, number, number, string];
    if (major !== 1 || minMinor !== 0 || role !== 1) {
      this.#fatal(Opcode.Hello, 1002, 'Unsupported version or role');
      return;
    }
    const claims = this.#server.verify(token);
    if (claims === undefined) {
      this.#fatal(Opcode.Hello, 1100, 'Invalid local ticket');
      return;
    }
    clearTimeout(this.#handshake);
    this.#userId = claims.userId;
    this.#email = claims.verifiedEmail;
    this.#expiresAtMs = claims.expiresAtMs;
    this.#armExpiry();
    this.#sessionId = this.#server.nextSessionId();
    this.#send({
      opcode: Opcode.Welcome,
      payload: [
        1, 0, this.#sessionId, this.#server.epoch, this.#server.enrolled(claims.userId),
        [[this.#server.coordinatorName, 1, 1]],
        [LIMITS.frameBytes, LIMITS.inflightCalls, LIMITS.subscriptions, MAX_QUEUED_BYTES],
        claims.expiresAtMs,
      ],
    });
    this.bootstrap();
    this.#server.logger?.write({ level: 'info', event: 'direct_session_opened' });
  }

  #armExpiry(): void {
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
    const remaining = Math.min(this.#expiresAtMs - Date.now(), 2_147_483_647);
    this.#expiry = setTimeout(() => this.#fatal(0, 1101, 'Local ticket expired'), Math.max(0, remaining));
  }

  #reauth(frame: Frame): void {
    const [requestId, token] = frame.payload as [number, string];
    const claims = this.#server.verify(token);
    if (claims === undefined || claims.userId !== this.#userId) {
      this.#fatal(Opcode.Reauth, 1100, 'Invalid local ticket');
      return;
    }
    this.#expiresAtMs = claims.expiresAtMs;
    this.#armExpiry();
    this.#send({ opcode: Opcode.ReauthOk, payload: [requestId, claims.expiresAtMs] });
  }

  /** Dictionaries and the snapshot, in the relay's order. */
  bootstrap(): void {
    if (this.#userId === undefined) return;
    this.#sendState();
    this.#send({ opcode: Opcode.TopicDict, payload: [this.#server.epoch, true, []] });
    this.#send({ opcode: Opcode.FunctionDict, payload: [this.#server.epoch, true, this.#server.functionEntries()] });
  }

  #sendState(): void {
    const userId = this.#userId as string;
    const dictionary: [number, string][] = [];
    const values: [number, ProtocolValue][] = [];
    for (const [path, value] of [...this.#server.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!this.#server.visible(userId, path)) continue;
      const id = this.#server.pathId(path) as number;
      dictionary.push([id, path]);
      values.push([id, value]);
    }
    values.sort((a, b) => a[0] - b[0]);
    this.#send({ opcode: Opcode.StateDict, payload: [this.#server.epoch, true, dictionary] });
    this.#send({ opcode: Opcode.StateSnapshot, payload: [this.#server.epoch, this.#server.revision, values] });
    this.#lastRevision = this.#server.revision;
  }

  patch(mutations: readonly StateMutation[], _previousRevision: number): void {
    if (this.#userId === undefined) return;
    const userId = this.#userId;
    const wire: ProtocolValue[] = [];
    for (const mutation of mutations) {
      if (!this.#server.visible(userId, mutation.path)) continue;
      const id = this.#server.pathId(mutation.path) as number;
      wire.push('delete' in mutation ? [id, 1] : [id, 0, mutation.value]);
    }
    if (wire.length === 0) return;
    try {
      this.#send({ opcode: Opcode.StatePatch, payload: [this.#server.epoch, this.#lastRevision, this.#server.revision, wire] });
      this.#lastRevision = this.#server.revision;
    } catch {
      // Too large for one frame: a snapshot carries it.
      this.#sendState();
    }
  }

  #call(frame: Frame): void {
    const [callId, , , functionId, timeoutMs, idempotencyKey, , args] = frame.payload as [
      number, number, ProtocolValue, number, number, string | null, number, ProtocolValue,
    ];
    const error = (code: number, message: string, retryable = false) => this.#send({
      opcode: Opcode.CallError,
      payload: [callId, code, retryable, message, null],
    });
    if (this.#calls.has(callId)) { error(1301, 'Duplicate call'); return; }
    if (this.#calls.size >= LIMITS.inflightCalls) { error(1004, 'Too many calls in flight'); return; }
    const declared = this.#server.functionById(functionId);
    if (declared === undefined) { error(1202, 'Function is not declared'); return; }
    const userId = this.#userId as string;
    if (!this.#server.enrolled(userId) && declared.name !== 'miakapp.join') { error(1201, 'Not enrolled'); return; }
    const controller = new AbortController();
    const route: InboundCall = {
      controller,
      done: false,
      timer: setTimeout(() => {
        if (route.done) return;
        route.done = true;
        controller.abort(new Error('deadline'));
        this.#calls.delete(callId);
        error(1404, 'Call deadline expired');
      }, timeoutMs),
    };
    this.#calls.set(callId, route);
    this.#send({ opcode: Opcode.CallAccepted, payload: [callId] });
    const source: Principal = Object.freeze({
      kind: 'user',
      id: userId,
      sessionId: this.#sessionId,
      coordinatorName: null,
      verifiedEmail: this.#email,
      transport: 'direct',
    });
    const incoming: IncomingCall = Object.freeze({
      source,
      arguments: args,
      idempotencyKey,
      signal: controller.signal,
      emit: () => Promise.reject(new Error('Progress is not available to browser callers')),
    });
    const finish = (frameToSend: Frame) => {
      if (route.done) return;
      route.done = true;
      clearTimeout(route.timer);
      this.#calls.delete(callId);
      this.#send(frameToSend);
    };
    void Promise.resolve()
      .then(() => declared.handler(incoming))
      .then((value) => finish({ opcode: Opcode.CallResult, payload: [callId, true, value ?? null] }))
      .catch((thrown: unknown) => {
        const application = thrown instanceof ApplicationCallError ? thrown : undefined;
        if (application === undefined) this.#server.logger?.write({ level: 'error', event: 'function_handler_failed' });
        finish({
          opcode: Opcode.CallError,
          payload: application === undefined
            ? [callId, 1500, false, 'Application handler failed', null]
            : [callId, application.code, application.retryable, application.message, null],
        });
      })
      .catch(() => undefined);
  }

  #cancel(frame: Frame): void {
    const [callId] = frame.payload as [number];
    const route = this.#calls.get(callId);
    if (route === undefined || route.done) return;
    route.done = true;
    clearTimeout(route.timer);
    route.controller.abort(new Error('cancelled'));
    this.#calls.delete(callId);
    this.#send({ opcode: Opcode.CallError, payload: [callId, 1404, false, 'Call cancelled after acceptance', null] });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#handshake);
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
    for (const route of this.#calls.values()) {
      clearTimeout(route.timer);
      route.controller.abort(new Error('closed'));
    }
    this.#calls.clear();
    const channel = this.#channel;
    later(() => channel.close());
    this.#onClose();
  }
}
