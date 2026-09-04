import {
  decodeFrame,
  encodeFrame,
  Opcode,
  type Frame,
} from './codec.js';

export type ProtocolSessionPhase =
  | 'fresh'
  | 'awaiting_welcome'
  | 'active'
  | 'draining'
  | 'closed';

export class ProtocolSessionError extends Error {
  readonly kind: 'wrong_direction' | 'unexpected_frame';

  constructor(kind: 'wrong_direction' | 'unexpected_frame', message: string) {
    super(message);
    this.name = 'ProtocolSessionError';
    this.kind = kind;
  }
}

const ACTIVE_OUTGOING = new Set<number>([
  Opcode.Reauth,
  Opcode.StateSync,
  Opcode.StateSet,
  Opcode.StateAclSync,
  Opcode.EventSync,
  Opcode.EventAclSync,
  Opcode.Subscribe,
  Opcode.Unsubscribe,
  Opcode.Event,
  Opcode.FunctionSync,
  Opcode.Call,
  Opcode.CallResult,
  Opcode.CallError,
  Opcode.CallCancel,
  Opcode.CallCredit,
]);

const ACTIVE_INCOMING = new Set<number>([
  Opcode.Error,
  Opcode.Fatal,
  Opcode.ReauthOk,
  Opcode.Goaway,
  Opcode.StateSyncOk,
  Opcode.StateDict,
  Opcode.StateSetOk,
  Opcode.StateAclOk,
  Opcode.EventSyncOk,
  Opcode.TopicDict,
  Opcode.EventAclOk,
  Opcode.SubscribeOk,
  Opcode.UnsubscribeOk,
  Opcode.Event,
  Opcode.FunctionSyncOk,
  Opcode.FunctionDict,
  Opcode.CallDispatch,
  Opcode.CallAccepted,
  Opcode.CallResult,
  Opcode.CallError,
  Opcode.CallCancel,
  Opcode.CallCredit,
  Opcode.PresenceSnapshot,
  Opcode.PresenceChange,
]);

const DRAINING_OUTGOING = new Set<number>([
  Opcode.CallResult,
  Opcode.CallError,
]);

function wrongDirection(opcode: number, direction: 'outgoing' | 'incoming'): never {
  throw new ProtocolSessionError(
    'wrong_direction',
    `Opcode 0x${opcode.toString(16).padStart(2, '0')} is not valid ${direction} coordinator traffic`,
  );
}

function unexpected(opcode: number, phase: ProtocolSessionPhase): never {
  throw new ProtocolSessionError(
    'unexpected_frame',
    `Opcode 0x${opcode.toString(16).padStart(2, '0')} is not valid during ${phase}`,
  );
}

function validateEventArity(frame: Frame, direction: 'outgoing' | 'incoming'): void {
  if (frame.opcode !== Opcode.Event) return;
  const expected = direction === 'outgoing' ? 5 : 6;
  if (frame.payload.length !== expected) wrongDirection(frame.opcode, direction);
}

export class CoordinatorProtocolSession {
  #phase: ProtocolSessionPhase = 'fresh';

  get phase(): ProtocolSessionPhase {
    return this.#phase;
  }

  encode(frame: Frame): Uint8Array {
    validateEventArity(frame, 'outgoing');
    if (this.#phase === 'fresh') {
      if (frame.opcode !== Opcode.Hello) unexpected(frame.opcode, this.#phase);
      const encoded = encodeFrame(frame);
      this.#phase = 'awaiting_welcome';
      return encoded;
    }
    if (this.#phase === 'active') {
      if (!ACTIVE_OUTGOING.has(frame.opcode)) wrongDirection(frame.opcode, 'outgoing');
      return encodeFrame(frame);
    }
    if (this.#phase === 'draining') {
      if (!DRAINING_OUTGOING.has(frame.opcode)) unexpected(frame.opcode, this.#phase);
      return encodeFrame(frame);
    }
    return unexpected(frame.opcode, this.#phase);
  }

  decode(bytes: Uint8Array): Frame {
    const frame = decodeFrame(bytes);
    validateEventArity(frame, 'incoming');
    if (this.#phase === 'awaiting_welcome') {
      if (frame.opcode === Opcode.Welcome) {
        this.#phase = 'active';
        return frame;
      }
      if (frame.opcode === Opcode.Fatal) {
        this.#phase = 'closed';
        return frame;
      }
      return unexpected(frame.opcode, this.#phase);
    }
    if (this.#phase === 'active' || this.#phase === 'draining') {
      if (!ACTIVE_INCOMING.has(frame.opcode)) wrongDirection(frame.opcode, 'incoming');
      if (frame.opcode === Opcode.Goaway) this.#phase = 'draining';
      if (frame.opcode === Opcode.Fatal) this.#phase = 'closed';
      return frame;
    }
    return unexpected(frame.opcode, this.#phase);
  }

  close(): void {
    this.#phase = 'closed';
  }
}
