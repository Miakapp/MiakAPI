import {
  decodeFrame,
  encodeFrame,
  Opcode,
  type Frame,
} from './codec.js';

export type UserProtocolSessionPhase =
  | 'fresh'
  | 'awaiting_welcome'
  | 'active'
  | 'draining'
  | 'closed';

export class UserProtocolSessionError extends Error {
  readonly kind: 'wrong_direction' | 'unexpected_frame';

  constructor(kind: 'wrong_direction' | 'unexpected_frame', message: string) {
    super(message);
    this.name = 'UserProtocolSessionError';
    this.kind = kind;
  }
}

const ACTIVE_OUTGOING = new Set<number>([
  Opcode.Reauth,
  Opcode.StateResync,
  Opcode.Subscribe,
  Opcode.Unsubscribe,
  Opcode.Event,
  Opcode.Call,
  Opcode.CallCancel,
  Opcode.CallCredit,
  Opcode.CallError,
]);

const ACTIVE_INCOMING = new Set<number>([
  Opcode.Error,
  Opcode.Fatal,
  Opcode.ReauthOk,
  Opcode.HomeStatus,
  Opcode.Goaway,
  Opcode.StateDict,
  Opcode.StateSnapshot,
  Opcode.StatePatch,
  Opcode.TopicDict,
  Opcode.SubscribeOk,
  Opcode.UnsubscribeOk,
  Opcode.Event,
  Opcode.FunctionDict,
  Opcode.CallDispatch,
  Opcode.CallAccepted,
  Opcode.CallResult,
  Opcode.CallError,
  Opcode.CallCancel,
  Opcode.CallCredit,
]);

const DRAINING_OUTGOING = new Set<number>([
  Opcode.CallResult,
  Opcode.CallError,
]);

function wrongDirection(opcode: number, direction: 'outgoing' | 'incoming'): never {
  throw new UserProtocolSessionError(
    'wrong_direction',
    `Opcode 0x${opcode.toString(16).padStart(2, '0')} is not valid ${direction} user traffic`,
  );
}

function unexpected(opcode: number, phase: UserProtocolSessionPhase): never {
  throw new UserProtocolSessionError(
    'unexpected_frame',
    `Opcode 0x${opcode.toString(16).padStart(2, '0')} is not valid during ${phase}`,
  );
}

function validateEventArity(frame: Frame, direction: 'outgoing' | 'incoming'): void {
  if (frame.opcode !== Opcode.Event) return;
  const expected = direction === 'outgoing' ? 5 : 6;
  if (frame.payload.length !== expected) wrongDirection(frame.opcode, direction);
}

export class UserProtocolSession {
  #phase: UserProtocolSessionPhase = 'fresh';

  get phase(): UserProtocolSessionPhase {
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
      if (frame.opcode >= 0x80) return frame;
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
