import { describe, expect, test } from 'bun:test';
import {
  decodeFrame,
  encodeFrame,
  Opcode,
  ProtocolError,
} from '../src/protocol/codec.js';
import { CoordinatorProtocolSession, ProtocolSessionError } from '../src/protocol/session.js';

describe('protocol integration', () => {
  test('encodes maps canonically and round-trips binary values', () => {
    const first = encodeFrame({
      opcode: 0x80,
      payload: [{ zebra: 1, alpha: new Uint8Array([4, 5]) }],
    });
    const second = encodeFrame({
      opcode: 0x80,
      payload: [{ alpha: new Uint8Array([4, 5]), zebra: 1 }],
    });
    expect(first).toEqual(second);
    expect(decodeFrame(first)).toEqual({
      opcode: 0x80,
      payload: [{ alpha: new Uint8Array([4, 5]), zebra: 1 }],
    });
  });

  test('rejects a non-canonical map before decoding it', () => {
    const nonCanonical = new Uint8Array([
      0x80,
      0x91,
      0x82,
      0xa1, 0x62, 0x01,
      0xa1, 0x61, 0x02,
    ]);
    expect(() => decodeFrame(nonCanonical)).toThrow(ProtocolError);
    try {
      decodeFrame(nonCanonical);
    } catch (error) {
      expect(error instanceof ProtocolError && error.kind).toBe('non_canonical');
    }
  });

  test('enforces the coordinator session handshake and traffic directions', () => {
    const session = new CoordinatorProtocolSession();
    expect(() => session.encode({ opcode: Opcode.StateSync, payload: [1, []] }))
      .toThrow(ProtocolSessionError);

    session.encode({ opcode: Opcode.Hello, payload: [1, 0, 0, 2, 'token', ['coordinator']] });
    expect(session.phase).toBe('awaiting_welcome');
    expect(() => session.decode(encodeFrame({ opcode: Opcode.StateSyncOk, payload: [1, new Uint8Array(16), 1, []] })))
      .toThrow(ProtocolSessionError);
  });

  test('distinguishes the two EVENT wire shapes by direction', () => {
    const outgoing = new CoordinatorProtocolSession();
    outgoing.encode({ opcode: Opcode.Hello, payload: [1, 0, 0, 2, 'token', ['coordinator']] });
    outgoing.decode(encodeFrame({
      opcode: Opcode.Welcome,
      payload: [1, 0, 1, new Uint8Array(16), true, [['coordinator', 1, 1]], [1, 1, 1, 1], 1],
    }));
    expect(() => outgoing.encode({
      opcode: Opcode.Event,
      payload: [1, 1, 0, null, [1, 'user', 1, null, null], true],
    })).toThrow(ProtocolSessionError);
    expect(() => outgoing.decode(encodeFrame({
      opcode: Opcode.Event,
      payload: [1, 1, 0, null, true],
    }))).toThrow(ProtocolSessionError);
  });
});
