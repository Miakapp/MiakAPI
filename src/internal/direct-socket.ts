/**
 * Browser side of the direct (local network) transport: a WebRTC DataChannel
 * opened to a coordinator without any signaling server.
 *
 * The coordinator publishes fixed coordinates while online (addresses, UDP
 * port, the SHA-256 fingerprint of its persistent DTLS certificate and a fixed
 * ICE password). The browser creates its own offer untouched, then builds the
 * coordinator's answer itself: the coordinator's ICE username is `mkd1` + the
 * browser's own ICE password, which tells the coordinator everything it needs
 * from the first STUN request. No SDP munging of the local description.
 */
import { LIMITS } from '../protocol/codec.js';
import type { ManagedSocket, SocketHandlers } from './runtime.js';

export interface DirectCoordinates {
  /** IPv4 addresses (or hostnames) the coordinator listens on. */
  readonly hosts: readonly string[];
  readonly port: number;
  /** Uppercase colon-separated SHA-256 fingerprint of the coordinator's DTLS certificate. */
  readonly fingerprint: string;
  /** The coordinator's fixed ICE password. */
  readonly pwd: string;
}

const MAX_QUEUED_BYTES = 1_048_576;
const UFRAG_PREFIX = 'mkd1';
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
const ICE_CHARS = /^[A-Za-z0-9+/]{22,256}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

export function parseDirectCoordinates(value: unknown): DirectCoordinates | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { hosts, port, fingerprint, pwd } = record;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 8) return undefined;
  if (!hosts.every((host) => typeof host === 'string' && HOST.test(host))) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return undefined;
  if (typeof pwd !== 'string' || !ICE_CHARS.test(pwd)) return undefined;
  return Object.freeze({ hosts: Object.freeze([...hosts as string[]]), port, fingerprint, pwd });
}

interface NativeDataChannel {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: string;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

interface NativePeerConnection {
  readonly connectionState: string;
  readonly localDescription: { readonly sdp: string } | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string, options?: Record<string, unknown>): NativeDataChannel;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description?: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  close(): void;
}

type NativePeerConnectionConstructor = new (config: Record<string, unknown>) => NativePeerConnection;

export function directTransportAvailable(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

function answerFor(offerSdp: string, coordinates: DirectCoordinates): string {
  const pwd = /a=ice-pwd:([A-Za-z0-9+/]+)/.exec(offerSdp)?.[1];
  const mid = /a=mid:(\S+)/.exec(offerSdp)?.[1];
  if (pwd === undefined || mid === undefined) throw new Error('Browser offer has no ICE password or mid');
  const first = coordinates.hosts[0] as string;
  const lines = [
    'v=0', 'o=- 0 0 IN IP4 0.0.0.0', 's=-', 't=0 0', `a=group:BUNDLE ${mid}`,
    `m=application ${coordinates.port} UDP/DTLS/SCTP webrtc-datachannel`,
    `c=IN IP4 ${/^\d+\.\d+\.\d+\.\d+$/.test(first) ? first : '0.0.0.0'}`,
    `a=mid:${mid}`,
    `a=ice-ufrag:${UFRAG_PREFIX}${pwd}`,
    `a=ice-pwd:${coordinates.pwd}`,
    `a=fingerprint:sha-256 ${coordinates.fingerprint}`,
    'a=setup:passive',
    'a=sctp-port:5000',
    `a=max-message-size:${LIMITS.frameBytes}`,
  ];
  coordinates.hosts.forEach((host, index) => {
    lines.push(`a=candidate:${index + 1} 1 udp ${2_130_706_431 - index} ${host} ${coordinates.port} typ host`);
  });
  lines.push('a=end-of-candidates', '');
  return lines.join('\r\n');
}

class DirectManagedSocket implements ManagedSocket {
  readonly #pc: NativePeerConnection;
  readonly #channel: NativeDataChannel;
  #handlers: SocketHandlers | undefined;
  #closed = false;
  #detached = false;

  constructor(pc: NativePeerConnection, channel: NativeDataChannel) {
    this.#pc = pc;
    this.#channel = channel;
    channel.onmessage = (event) => {
      if (this.#detached || this.#handlers === undefined) return;
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > LIMITS.frameBytes) {
        this.#handlers.error(new Error('Coordinator sent an invalid direct message'));
        this.terminate();
        return;
      }
      this.#handlers.message(new Uint8Array(event.data));
    };
    channel.onclose = () => this.#didClose(1006, 'direct channel closed');
    channel.onerror = () => {
      if (!this.#detached) this.#handlers?.error(new Error('Direct channel error'));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.#didClose(1006, `direct connection ${pc.connectionState}`);
      }
    };
  }

  bind(handlers: SocketHandlers): this {
    this.#handlers = handlers;
    return this;
  }

  #didClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    // Not from inside the connection's own event (native implementations abort on it).
    const pc = this.#pc;
    setTimeout(() => {
      try { pc.close(); } catch { /* already closed */ }
    }, 0);
    if (!this.#detached) this.#handlers?.close(code, reason);
  }

  get bufferedBytes(): number {
    return this.#channel.bufferedAmount;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#closed || this.#channel.readyState !== 'open') {
      return Promise.reject(new Error('Direct channel is not open'));
    }
    if (bytes.byteLength > LIMITS.frameBytes || this.#channel.bufferedAmount + bytes.byteLength > MAX_QUEUED_BYTES) {
      return Promise.reject(new RangeError('Direct channel outbound queue limit exceeded'));
    }
    try {
      this.#channel.send(bytes);
      return Promise.resolve();
    } catch {
      return Promise.reject(new Error('Direct channel send failed'));
    }
  }

  close(): void {
    try { this.#channel.close(); } catch { /* ignore */ }
    this.#didClose(1000, 'shutdown');
  }

  terminate(): void {
    this.close();
  }

  detach(): void {
    this.#detached = true;
  }
}

export type DirectSocket = ManagedSocket & { bind(handlers: SocketHandlers): ManagedSocket };

/**
 * Opens a DataChannel to the coordinator. Resolves once the channel is open;
 * rejects on failure, timeout or abort. Bind handlers before writing.
 */
export async function openDirectSocket(
  coordinates: DirectCoordinates,
  signal: AbortSignal,
  timeoutMs = 3_000,
): Promise<DirectSocket> {
  if (signal.aborted) throw signal.reason;
  const Constructor = (globalThis as { RTCPeerConnection?: NativePeerConnectionConstructor }).RTCPeerConnection;
  if (Constructor === undefined) throw new Error('WebRTC is not available');
  const pc = new Constructor({ iceServers: [] });
  const channel = pc.createDataChannel('miakapp', { ordered: true });
  channel.binaryType = 'arraybuffer';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(error);
      timer = setTimeout(() => fail(new Error('Direct connection timed out')), timeoutMs);
      onAbort = () => fail(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      channel.onopen = () => resolve();
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') fail(new Error('Direct connection failed'));
      };
      void (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        const offer = pc.localDescription?.sdp;
        if (offer === undefined) throw new Error('No local description');
        await pc.setRemoteDescription({ type: 'answer', sdp: answerFor(offer, coordinates) });
      })().catch(fail);
    });
  } catch (error) {
    try { pc.close(); } catch { /* ignore */ }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    channel.onopen = null;
  }
  return new DirectManagedSocket(pc, channel);
}
