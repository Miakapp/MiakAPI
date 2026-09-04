import { decode } from '@msgpack/msgpack';

export const LIMITS = {
  frameBytes: 262_144,
  depth: 16,
  values: 16_384,
  stringBytes: 65_536,
  binaryBytes: 131_072,
  arrayItems: 4_096,
  mapEntries: 4_096,
  mapKeyBytes: 256,
  statePathsPerCoordinator: 4_096,
  statePathsPerHome: 16_384,
  declarationsPerCoordinator: 1_024,
  subscriptions: 256,
  inflightCalls: 128,
  streamCredit: 32,
  callTimeoutMs: 300_000,
} as const;

export const Opcode = {
  Hello: 0x00,
  Welcome: 0x01,
  Error: 0x02,
  Fatal: 0x03,
  Reauth: 0x04,
  ReauthOk: 0x05,
  HomeStatus: 0x06,
  Goaway: 0x07,
  StateSync: 0x10,
  StateSyncOk: 0x11,
  StateDict: 0x12,
  StateSnapshot: 0x13,
  StatePatch: 0x14,
  StateSet: 0x15,
  StateSetOk: 0x16,
  StateAclSync: 0x17,
  StateAclOk: 0x18,
  StateResync: 0x19,
  EventSync: 0x20,
  EventSyncOk: 0x21,
  TopicDict: 0x22,
  EventAclSync: 0x23,
  EventAclOk: 0x24,
  Subscribe: 0x25,
  SubscribeOk: 0x26,
  Unsubscribe: 0x27,
  UnsubscribeOk: 0x28,
  Event: 0x29,
  FunctionSync: 0x30,
  FunctionSyncOk: 0x31,
  FunctionDict: 0x32,
  Call: 0x33,
  CallDispatch: 0x34,
  CallAccepted: 0x35,
  CallResult: 0x36,
  CallError: 0x37,
  CallCancel: 0x38,
  CallCredit: 0x39,
  PresenceSnapshot: 0x40,
  PresenceChange: 0x41,
} as const;

const KNOWN_CORE_OPCODES = new Set<number>(Object.values(Opcode));
const ERROR_CORRELATION_SOURCE_OPCODES = new Set<number>([
  Opcode.Reauth,
  Opcode.StateSync,
  Opcode.StateSet,
  Opcode.StateAclSync,
  Opcode.StateResync,
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
const KNOWN_CORE_ERROR_CODES = new Set<number>([
  1000, 1001, 1002, 1003, 1004, 1005,
  1100, 1101, 1102,
  1200, 1201, 1202, 1203,
  1300, 1301, 1302, 1303, 1304, 1305,
  1400, 1401, 1402, 1403, 1404, 1405,
  1500,
]);
const APPLICATION_ERROR_CODE_MINIMUM = 2000;
const APPLICATION_ERROR_CODE_MAXIMUM = 2999;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type ProtocolErrorKind =
  | 'malformed'
  | 'non_canonical'
  | 'invalid_value'
  | 'limit'
  | 'unknown_opcode'
  | 'invalid_frame'
  | 'frame_too_large';

export class ProtocolError extends Error {
  readonly kind: ProtocolErrorKind;

  constructor(kind: ProtocolErrorKind, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.kind = kind;
  }
}

export type ProtocolObject = { [key: string]: ProtocolValue };
export type ProtocolValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | ProtocolValue[]
  | ProtocolObject;

export interface Frame {
  opcode: number;
  payload: ProtocolValue[];
}

interface ScanState {
  nodes: number;
}

interface ScanResult {
  end: number;
  kind: 'null' | 'boolean' | 'integer' | 'float' | 'string' | 'binary' | 'array' | 'map';
  stringBytes?: Uint8Array;
  stringValue?: string;
}

interface EncodeState {
  nodes: number;
  bytes: number;
}

function fail(kind: ProtocolErrorKind, message: string): never {
  throw new ProtocolError(kind, message);
}

function accountEncodedBytes(state: EncodeState, length: number): void {
  state.bytes += length;
  if (state.bytes > LIMITS.frameBytes - 1) {
    fail('frame_too_large', 'encoded frame exceeds byte limit');
  }
}

function encodedAtom(state: EncodeState, value: Uint8Array): Uint8Array {
  accountEncodedBytes(state, value.length);
  return value;
}

function ensureAvailable(input: Uint8Array, offset: number, length: number): void {
  if (length < 0 || offset < 0 || offset + length > input.length) {
    fail('malformed', 'truncated MessagePack value');
  }
}

function view(input: Uint8Array, offset: number, length: number): DataView {
  ensureAvailable(input, offset, length);
  return new DataView(input.buffer, input.byteOffset + offset, length);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function scanString(
  input: Uint8Array,
  start: number,
  length: number,
  next: number,
): ScanResult {
  if (length > LIMITS.stringBytes) fail('limit', 'string length exceeds limit');
  ensureAvailable(input, start, length);
  const bytes = input.subarray(start, start + length);
  let value: string;
  try {
    value = textDecoder.decode(bytes);
  } catch {
    fail('invalid_value', 'string is not valid UTF-8');
  }
  return {
    end: next + length,
    kind: 'string',
    stringBytes: bytes,
    stringValue: value,
  };
}

function scanBinary(input: Uint8Array, start: number, length: number, next: number): ScanResult {
  if (length > LIMITS.binaryBytes) fail('limit', 'binary length exceeds limit');
  ensureAvailable(input, start, length);
  return { end: next + length, kind: 'binary' };
}

function scanArray(
  input: Uint8Array,
  offset: number,
  length: number,
  depth: number,
  state: ScanState,
): ScanResult {
  if (length > LIMITS.arrayItems) fail('limit', 'array length exceeds limit');
  let cursor = offset;
  for (let index = 0; index < length; index += 1) {
    cursor = scanValue(input, cursor, depth + 1, state).end;
  }
  return { end: cursor, kind: 'array' };
}

function scanMap(
  input: Uint8Array,
  offset: number,
  length: number,
  depth: number,
  state: ScanState,
): ScanResult {
  if (length > LIMITS.mapEntries) fail('limit', 'map length exceeds limit');
  let cursor = offset;
  let previous: Uint8Array | undefined;
  for (let index = 0; index < length; index += 1) {
    const key = scanValue(input, cursor, depth + 1, state);
    if (key.kind !== 'string' || !key.stringBytes || key.stringValue === undefined) {
      fail('invalid_value', 'map keys must be strings');
    }
    if (key.stringBytes.length > LIMITS.mapKeyBytes) fail('limit', 'map key exceeds limit');
    if (key.stringValue === '__proto__') fail('invalid_value', 'reserved map key');
    if (previous) {
      const order = compareBytes(previous, key.stringBytes);
      if (order === 0) fail('invalid_value', 'duplicate map key');
      if (order > 0) fail('non_canonical', 'map keys are not in UTF-8 byte order');
    }
    previous = key.stringBytes;
    cursor = scanValue(input, key.end, depth + 1, state).end;
  }
  return { end: cursor, kind: 'map' };
}

function scanValue(
  input: Uint8Array,
  offset: number,
  depth: number,
  state: ScanState,
): ScanResult {
  if (depth > LIMITS.depth) fail('limit', 'value nesting exceeds limit');
  state.nodes += 1;
  if (state.nodes > LIMITS.values) fail('limit', 'payload value count exceeds limit');
  ensureAvailable(input, offset, 1);
  const marker = input[offset]!;
  const next = offset + 1;

  if (marker <= 0x7f || marker >= 0xe0) return { end: next, kind: 'integer' };
  if (marker >= 0x80 && marker <= 0x8f) {
    return scanMap(input, next, marker & 0x0f, depth, state);
  }
  if (marker >= 0x90 && marker <= 0x9f) {
    return scanArray(input, next, marker & 0x0f, depth, state);
  }
  if (marker >= 0xa0 && marker <= 0xbf) {
    return scanString(input, next, marker & 0x1f, next);
  }

  switch (marker) {
    case 0xc0:
      return { end: next, kind: 'null' };
    case 0xc1:
      return fail('malformed', 'reserved MessagePack marker');
    case 0xc2:
    case 0xc3:
      return { end: next, kind: 'boolean' };
    case 0xc4: {
      ensureAvailable(input, next, 1);
      const length = input[next]!;
      return scanBinary(input, next + 1, length, next + 1);
    }
    case 0xc5: {
      const length = view(input, next, 2).getUint16(0);
      if (length <= 0xff) fail('non_canonical', 'non-shortest binary length');
      return scanBinary(input, next + 2, length, next + 2);
    }
    case 0xc6: {
      const length = view(input, next, 4).getUint32(0);
      if (length <= 0xffff) fail('non_canonical', 'non-shortest binary length');
      return scanBinary(input, next + 4, length, next + 4);
    }
    case 0xca:
      ensureAvailable(input, next, 4);
      return fail('non_canonical', 'float32 is forbidden');
    case 0xcb: {
      const value = view(input, next, 8).getFloat64(0);
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        fail('invalid_value', 'non-finite and negative-zero floats are forbidden');
      }
      if (Number.isInteger(value)) {
        if (Number.isSafeInteger(value)) fail('non_canonical', 'integral float must be an integer');
        fail('invalid_value', 'integral float exceeds the safe-integer range');
      }
      return { end: next + 8, kind: 'float' };
    }
    case 0xcc: {
      ensureAvailable(input, next, 1);
      const value = input[next]!;
      if (value <= 0x7f) fail('non_canonical', 'non-shortest unsigned integer');
      return { end: next + 1, kind: 'integer' };
    }
    case 0xcd: {
      const value = view(input, next, 2).getUint16(0);
      if (value <= 0xff) fail('non_canonical', 'non-shortest unsigned integer');
      return { end: next + 2, kind: 'integer' };
    }
    case 0xce: {
      const value = view(input, next, 4).getUint32(0);
      if (value <= 0xffff) fail('non_canonical', 'non-shortest unsigned integer');
      return { end: next + 4, kind: 'integer' };
    }
    case 0xcf: {
      const value = view(input, next, 8).getBigUint64(0);
      if (value <= 0xffff_ffffn) fail('non_canonical', 'non-shortest unsigned integer');
      if (value > BigInt(MAX_SAFE_INTEGER)) fail('invalid_value', 'integer exceeds safe range');
      return { end: next + 8, kind: 'integer' };
    }
    case 0xd0: {
      const value = view(input, next, 1).getInt8(0);
      if (value >= -32) fail('non_canonical', 'non-shortest signed integer');
      return { end: next + 1, kind: 'integer' };
    }
    case 0xd1: {
      const value = view(input, next, 2).getInt16(0);
      if (value >= -128) fail('non_canonical', 'non-shortest signed integer');
      return { end: next + 2, kind: 'integer' };
    }
    case 0xd2: {
      const value = view(input, next, 4).getInt32(0);
      if (value >= -32_768) fail('non_canonical', 'non-shortest signed integer');
      return { end: next + 4, kind: 'integer' };
    }
    case 0xd3: {
      const value = view(input, next, 8).getBigInt64(0);
      if (value >= -2_147_483_648n) fail('non_canonical', 'non-shortest signed integer');
      if (value < BigInt(MIN_SAFE_INTEGER)) fail('invalid_value', 'integer exceeds safe range');
      return { end: next + 8, kind: 'integer' };
    }
    case 0xd9: {
      ensureAvailable(input, next, 1);
      const length = input[next]!;
      if (length <= 31) fail('non_canonical', 'non-shortest string length');
      return scanString(input, next + 1, length, next + 1);
    }
    case 0xda: {
      const length = view(input, next, 2).getUint16(0);
      if (length <= 0xff) fail('non_canonical', 'non-shortest string length');
      return scanString(input, next + 2, length, next + 2);
    }
    case 0xdb: {
      const length = view(input, next, 4).getUint32(0);
      if (length <= 0xffff) fail('non_canonical', 'non-shortest string length');
      return scanString(input, next + 4, length, next + 4);
    }
    case 0xdc: {
      const length = view(input, next, 2).getUint16(0);
      if (length <= 15) fail('non_canonical', 'non-shortest array length');
      return scanArray(input, next + 2, length, depth, state);
    }
    case 0xdd: {
      const length = view(input, next, 4).getUint32(0);
      if (length > LIMITS.arrayItems) fail('limit', 'array length exceeds limit');
      if (length <= 0xffff) fail('non_canonical', 'non-shortest array length');
      return scanArray(input, next + 4, length, depth, state);
    }
    case 0xde: {
      const length = view(input, next, 2).getUint16(0);
      if (length <= 15) fail('non_canonical', 'non-shortest map length');
      return scanMap(input, next + 2, length, depth, state);
    }
    case 0xdf: {
      const length = view(input, next, 4).getUint32(0);
      if (length > LIMITS.mapEntries) fail('limit', 'map length exceeds limit');
      if (length <= 0xffff) fail('non_canonical', 'non-shortest map length');
      return scanMap(input, next + 4, length, depth, state);
    }
    default:
      if ((marker >= 0xc7 && marker <= 0xc9) || (marker >= 0xd4 && marker <= 0xd8)) {
        return fail('invalid_value', 'MessagePack extensions are forbidden');
      }
      return fail('malformed', `unsupported MessagePack marker 0x${marker.toString(16)}`);
  }
}

function byte(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function numberBytes(marker: number, length: 1 | 2 | 4 | 8, setter: (view: DataView) => void): Uint8Array {
  const output = new Uint8Array(1 + length);
  output[0] = marker;
  setter(new DataView(output.buffer, 1, length));
  return output;
}

function encodeInteger(value: number): Uint8Array {
  if (value >= 0) {
    if (value <= 0x7f) return byte(value);
    if (value <= 0xff) return Uint8Array.of(0xcc, value);
    if (value <= 0xffff) return numberBytes(0xcd, 2, (target) => target.setUint16(0, value));
    if (value <= 0xffff_ffff) return numberBytes(0xce, 4, (target) => target.setUint32(0, value));
    return numberBytes(0xcf, 8, (target) => target.setBigUint64(0, BigInt(value)));
  }
  if (value >= -32) return byte(0x100 + value);
  if (value >= -128) return numberBytes(0xd0, 1, (target) => target.setInt8(0, value));
  if (value >= -32_768) return numberBytes(0xd1, 2, (target) => target.setInt16(0, value));
  if (value >= -2_147_483_648) return numberBytes(0xd2, 4, (target) => target.setInt32(0, value));
  return numberBytes(0xd3, 8, (target) => target.setBigInt64(0, BigInt(value)));
}

function encodeLength(
  length: number,
  fixedBase: number,
  fixedMaximum: number,
  marker8: number | null,
  marker16: number,
  marker32: number,
): Uint8Array {
  if (length <= fixedMaximum) return byte(fixedBase + length);
  if (marker8 !== null && length <= 0xff) return Uint8Array.of(marker8, length);
  if (length <= 0xffff) return numberBytes(marker16, 2, (target) => target.setUint16(0, length));
  return numberBytes(marker32, 4, (target) => target.setUint32(0, length));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function validUtf8String(value: string, maximum: number, label: string): Uint8Array {
  if (hasUnpairedSurrogate(value)) fail('invalid_value', `${label} contains an unpaired surrogate`);
  if (value.length > maximum) fail('limit', `${label} exceeds byte limit`);
  const encoded = textEncoder.encode(value);
  if (encoded.length > maximum) fail('limit', `${label} exceeds byte limit`);
  return encoded;
}

function encodeValue(value: ProtocolValue, depth: number, state: EncodeState): Uint8Array {
  if (depth > LIMITS.depth) fail('limit', 'value nesting exceeds limit');
  state.nodes += 1;
  if (state.nodes > LIMITS.values) fail('limit', 'payload value count exceeds limit');

  if (value === null) return encodedAtom(state, byte(0xc0));
  if (value === false) return encodedAtom(state, byte(0xc2));
  if (value === true) return encodedAtom(state, byte(0xc3));
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail('invalid_value', 'non-finite and negative-zero numbers are forbidden');
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) fail('invalid_value', 'integer exceeds safe range');
      return encodedAtom(state, encodeInteger(value));
    }
    return encodedAtom(state, numberBytes(0xcb, 8, (target) => target.setFloat64(0, value)));
  }
  if (typeof value === 'string') {
    const encoded = validUtf8String(value, LIMITS.stringBytes, 'string');
    const prefix = encodeLength(encoded.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
    accountEncodedBytes(state, prefix.length + encoded.length);
    return concat([prefix, encoded]);
  }
  if (value instanceof Uint8Array) {
    if (value.length > LIMITS.binaryBytes) fail('limit', 'binary length exceeds limit');
    const prefix = encodeLength(value.length, 0, -1, 0xc4, 0xc5, 0xc6);
    accountEncodedBytes(state, prefix.length + value.length);
    return concat([prefix, value]);
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.arrayItems) fail('limit', 'array length exceeds limit');
    const prefix = encodeLength(value.length, 0x90, 15, null, 0xdc, 0xdd);
    accountEncodedBytes(state, prefix.length);
    const encoded = value.map((item) => encodeValue(item, depth + 1, state));
    return concat([prefix, ...encoded]);
  }
  if (typeof value !== 'object') fail('invalid_value', 'unsupported protocol value');
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid_value', 'only plain objects are protocol maps');
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    fail('invalid_value', 'symbolic or non-enumerable map keys are forbidden');
  }
  if (keys.length > LIMITS.mapEntries) fail('limit', 'map length exceeds limit');
  const sorted = keys.map((key) => ({
    key,
    bytes: validUtf8String(key, LIMITS.mapKeyBytes, 'map key'),
  })).sort((left, right) => compareBytes(left.bytes, right.bytes));
  const prefix = encodeLength(sorted.length, 0x80, 15, null, 0xde, 0xdf);
  accountEncodedBytes(state, prefix.length);
  const parts: Uint8Array[] = [prefix];
  for (const { key } of sorted) {
    if (key === '__proto__') fail('invalid_value', 'reserved map key');
    parts.push(encodeValue(key, depth + 1, state));
    const child = value[key];
    if (child === undefined) fail('invalid_value', 'undefined map values are forbidden');
    parts.push(encodeValue(child, depth + 1, state));
  }
  return concat(parts);
}

function asArray(value: unknown, label: string, maximum: number = LIMITS.arrayItems): ProtocolValue[] {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid_frame', `${label} must be an array`);
  return value as ProtocolValue[];
}

function exactTuple(value: unknown, length: number, label: string): ProtocolValue[] {
  const tuple = asArray(value, label);
  if (tuple.length !== length) fail('invalid_frame', `${label} must contain ${length} fields`);
  return tuple;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('invalid_frame', `${label} must be an integer in range`);
  }
  return value as number;
}

function coreErrorCode(value: unknown, label: string): number {
  const code = integer(value, 1, 0xffff, label);
  if (!KNOWN_CORE_ERROR_CODES.has(code)) fail('invalid_frame', `${label} is not a known core error code`);
  return code;
}

function callErrorCode(value: unknown, label: string): number {
  const code = integer(value, 1, 0xffff, label);
  const isApplicationCode = code >= APPLICATION_ERROR_CODE_MINIMUM
    && code <= APPLICATION_ERROR_CODE_MAXIMUM;
  if (!KNOWN_CORE_ERROR_CODES.has(code) && !isApplicationCode) {
    fail('invalid_frame', `${label} is not a permitted call error code`);
  }
  return code;
}

function positiveId(value: unknown, label: string): number {
  return integer(value, 1, MAX_SAFE_INTEGER, label);
}

function correlationIdOrZero(value: unknown, label: string): number {
  return integer(value, 0, MAX_SAFE_INTEGER, label);
}

function errorCorrelation(correlationValue: unknown, sourceOpcodeValue: unknown): void {
  const correlationId = correlationIdOrZero(correlationValue, 'ERROR.correlationId');
  const sourceOpcode = integer(sourceOpcodeValue, 0, 0xff, 'ERROR.sourceOpcode');
  if (correlationId === 0) {
    if (sourceOpcode !== 0) {
      fail('invalid_frame', 'ERROR.sourceOpcode must be zero without an origin');
    }
    return;
  }
  if (!ERROR_CORRELATION_SOURCE_OPCODES.has(sourceOpcode)) {
    fail('invalid_frame', 'ERROR.sourceOpcode is not an originating frame');
  }
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('invalid_frame', `${label} must be a boolean`);
  return value;
}

function stringValue(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string') fail('invalid_frame', `${label} must be a string`);
  if (hasUnpairedSurrogate(value)) fail('invalid_frame', `${label} is not valid UTF-8`);
  if (value.length > maximum) fail('invalid_frame', `${label} exceeds byte limit`);
  const bytes = textEncoder.encode(value);
  if (bytes.length < minimum || bytes.length > maximum) {
    fail('invalid_frame', `${label} must be a string in range`);
  }
  return value;
}

function binaryValue(value: unknown, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    fail('invalid_frame', `${label} must be ${length} binary bytes`);
  }
  return value;
}

function nullableString(value: unknown, maximum: number, label: string): string | null {
  if (value === null) return null;
  return stringValue(value, 1, maximum, label);
}

function opaqueId(value: unknown, label: string): string {
  const result = stringValue(value, 1, 128, label);
  if (/\p{Cc}/u.test(result)) fail('invalid_frame', `${label} contains a control character`);
  return result;
}

function coordinatorName(value: unknown, label: string): string {
  const result = stringValue(value, 1, 64, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result)) {
    fail('invalid_frame', `${label} is not a coordinator name`);
  }
  return result;
}

function structuredName(value: unknown, label: string): string {
  const result = stringValue(value, 1, 256, label);
  if (/\p{Cc}/u.test(result) || result.includes('*') || result.startsWith('.') || result.endsWith('.') || result.includes('..')) {
    fail('invalid_frame', `${label} is not a valid dotted name`);
  }
  return result;
}

function pattern(value: unknown, label: string): string {
  const result = stringValue(value, 1, 256, label);
  structuredName(result.endsWith('.*') ? result.slice(0, -2) : result, label);
  return result;
}

function uniqueStrings(values: ProtocolValue[], validator: (value: unknown, label: string) => string, label: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const item = validator(value, `${label}[${index}]`);
    if (seen.has(item)) fail('invalid_frame', `${label} contains a duplicate`);
    seen.add(item);
  });
}

function uniqueIds(values: ProtocolValue[], label: string): void {
  const seen = new Set<number>();
  values.forEach((value, index) => {
    const item = positiveId(value, `${label}[${index}]`);
    if (seen.has(item)) fail('invalid_frame', `${label} contains a duplicate`);
    seen.add(item);
  });
}

function epoch(value: unknown, label: string): void {
  binaryValue(value, 16, label);
}

function coordinators(value: unknown, label: string): void {
  const entries = asArray(value, label, 64);
  const names = new Set<string>();
  entries.forEach((entry, index) => {
    const fields = exactTuple(entry, 3, `${label}[${index}]`);
    const name = coordinatorName(fields[0], `${label}[${index}].name`);
    if (names.has(name)) fail('invalid_frame', `${label} contains a duplicate coordinator`);
    names.add(name);
    positiveId(fields[1], `${label}[${index}].generation`);
    integer(fields[2], 1, 2, `${label}[${index}].status`);
  });
}

function dictionary(value: unknown, maximum: number, nameLabel: string): void {
  const entries = asArray(value, 'dictionary', maximum);
  const ids = new Set<number>();
  const names = new Set<string>();
  entries.forEach((entry, index) => {
    const fields = exactTuple(entry, 2, `dictionary[${index}]`);
    const id = positiveId(fields[0], `dictionary[${index}].id`);
    const name = structuredName(fields[1], `dictionary[${index}].${nameLabel}`);
    if (ids.has(id) || names.has(name)) fail('invalid_frame', 'dictionary entries must be unique');
    ids.add(id);
    names.add(name);
  });
}

function mutations(value: unknown, label: string): void {
  const entries = asArray(value, label, LIMITS.statePathsPerCoordinator);
  const ids = new Set<number>();
  entries.forEach((entry, index) => {
    const fields = asArray(entry, `${label}[${index}]`);
    if (fields.length !== 2 && fields.length !== 3) fail('invalid_frame', 'mutation has wrong arity');
    const id = positiveId(fields[0], `${label}[${index}].pathId`);
    if (ids.has(id)) fail('invalid_frame', `${label} contains a duplicate path ID`);
    ids.add(id);
    const operation = integer(fields[1], 0, 1, `${label}[${index}].operation`);
    if ((operation === 0 && fields.length !== 3) || (operation === 1 && fields.length !== 2)) {
      fail('invalid_frame', 'mutation arity does not match operation');
    }
  });
}

function aclPatterns(value: unknown, label: string): void {
  const values = asArray(value, label);
  uniqueStrings(values, pattern, label);
}

function target(kindValue: unknown, targetValue: unknown, label: string): void {
  const kind = integer(kindValue, 0, 2, `${label}.kind`);
  if (kind === 0 && targetValue !== null) fail('invalid_frame', `${label} default target must be null`);
  if (kind === 1) positiveId(targetValue, `${label}.session`);
  if (kind === 2) coordinatorName(targetValue, `${label}.coordinator`);
}

function principal(value: unknown, label: string): void {
  const fields = exactTuple(value, 5, label);
  const kind = integer(fields[0], 1, 3, `${label}.kind`);
  opaqueId(fields[1], `${label}.id`);
  positiveId(fields[2], `${label}.sessionId`);
  if (kind === 2) coordinatorName(fields[3], `${label}.coordinatorName`);
  else if (fields[3] !== null) fail('invalid_frame', `${label}.coordinatorName must be null`);
  nullableString(fields[4], 320, `${label}.email`);
}

function subscriptionPayload(payload: ProtocolValue[], label: string): void {
  const fields = exactTuple(payload, 2, label);
  positiveId(fields[0], `${label}.requestId`);
  const ids = asArray(fields[1], `${label}.topicIds`, LIMITS.subscriptions);
  uniqueIds(ids, `${label}.topicIds`);
}

function validateFrame(frame: Frame): void {
  const { opcode, payload } = frame;
  if (opcode >= 0x80) return;
  if (!KNOWN_CORE_OPCODES.has(opcode)) fail('unknown_opcode', 'unknown core opcode');

  switch (opcode) {
    case Opcode.Hello: {
      const fields = exactTuple(payload, 6, 'HELLO');
      integer(fields[0], 0, 0xff, 'HELLO.major');
      const minimum = integer(fields[1], 0, 0xff, 'HELLO.minMinor');
      const maximum = integer(fields[2], 0, 0xff, 'HELLO.maxMinor');
      if (minimum > maximum) fail('invalid_frame', 'HELLO minor range is inverted');
      const role = integer(fields[3], 1, 3, 'HELLO.role');
      stringValue(fields[4], 1, 16_384, 'HELLO.token');
      const context = asArray(fields[5], 'HELLO.context');
      if (role === 1) {
        const roleFields = exactTuple(context, 1, 'HELLO.userContext');
        opaqueId(roleFields[0], 'HELLO.homeId');
      } else if (role === 2) {
        const roleFields = exactTuple(context, 1, 'HELLO.coordinatorContext');
        coordinatorName(roleFields[0], 'HELLO.coordinatorName');
      } else if (context.length !== 0) fail('invalid_frame', 'HELLO CLI context must be empty');
      return;
    }
    case Opcode.Welcome: {
      const fields = exactTuple(payload, 8, 'WELCOME');
      integer(fields[0], 0, 0xff, 'WELCOME.major');
      integer(fields[1], 0, 0xff, 'WELCOME.minor');
      positiveId(fields[2], 'WELCOME.sessionId');
      epoch(fields[3], 'WELCOME.epoch');
      booleanValue(fields[4], 'WELCOME.enrolled');
      coordinators(fields[5], 'WELCOME.coordinators');
      const limits = exactTuple(fields[6], 4, 'WELCOME.limits');
      integer(limits[0], 1, LIMITS.frameBytes, 'WELCOME.maxFrameBytes');
      integer(limits[1], 1, LIMITS.inflightCalls, 'WELCOME.maxInflightCalls');
      integer(limits[2], 1, LIMITS.subscriptions, 'WELCOME.maxSubscriptions');
      integer(limits[3], 1, 1_048_576, 'WELCOME.maxQueuedBytes');
      positiveId(fields[7], 'WELCOME.expiresAtMs');
      return;
    }
    case Opcode.Error: {
      const fields = exactTuple(payload, 5, 'ERROR');
      errorCorrelation(fields[0], fields[1]);
      coreErrorCode(fields[2], 'ERROR.code');
      booleanValue(fields[3], 'ERROR.retryable');
      stringValue(fields[4], 1, 256, 'ERROR.message');
      return;
    }
    case Opcode.Fatal: {
      const fields = exactTuple(payload, 4, 'FATAL');
      integer(fields[0], 0, 0xff, 'FATAL.sourceOpcode');
      coreErrorCode(fields[1], 'FATAL.code');
      booleanValue(fields[2], 'FATAL.retryable');
      stringValue(fields[3], 1, 256, 'FATAL.message');
      return;
    }
    case Opcode.Reauth: {
      const fields = exactTuple(payload, 2, 'REAUTH');
      positiveId(fields[0], 'REAUTH.requestId');
      stringValue(fields[1], 1, 16_384, 'REAUTH.token');
      return;
    }
    case Opcode.ReauthOk: {
      const fields = exactTuple(payload, 2, 'REAUTH_OK');
      positiveId(fields[0], 'REAUTH_OK.requestId');
      positiveId(fields[1], 'REAUTH_OK.expiresAtMs');
      return;
    }
    case Opcode.HomeStatus: {
      const fields = exactTuple(payload, 2, 'HOME_STATUS');
      booleanValue(fields[0], 'HOME_STATUS.enrolled');
      coordinators(fields[1], 'HOME_STATUS.coordinators');
      return;
    }
    case Opcode.Goaway: {
      const fields = exactTuple(payload, 2, 'GOAWAY');
      integer(fields[0], 0, LIMITS.callTimeoutMs, 'GOAWAY.retryAfterMs');
      integer(fields[1], 0, 0xffff, 'GOAWAY.reasonCode');
      return;
    }
    case Opcode.StateSync: {
      const fields = exactTuple(payload, 2, 'STATE_SYNC');
      positiveId(fields[0], 'STATE_SYNC.requestId');
      const entries = asArray(fields[1], 'STATE_SYNC.entries', LIMITS.statePathsPerCoordinator);
      const paths = new Set<string>();
      entries.forEach((entry, index) => {
        const item = exactTuple(entry, 2, `STATE_SYNC.entries[${index}]`);
        const path = structuredName(item[0], `STATE_SYNC.entries[${index}].path`);
        if (paths.has(path)) fail('invalid_frame', 'STATE_SYNC contains a duplicate path');
        paths.add(path);
      });
      return;
    }
    case Opcode.StateSyncOk: {
      const fields = exactTuple(payload, 4, 'STATE_SYNC_OK');
      positiveId(fields[0], 'STATE_SYNC_OK.requestId');
      epoch(fields[1], 'STATE_SYNC_OK.epoch');
      positiveId(fields[2], 'STATE_SYNC_OK.revision');
      dictionary(fields[3], LIMITS.statePathsPerCoordinator, 'path');
      return;
    }
    case Opcode.StateDict: {
      const fields = exactTuple(payload, 3, 'STATE_DICT');
      epoch(fields[0], 'STATE_DICT.epoch');
      booleanValue(fields[1], 'STATE_DICT.replace');
      dictionary(fields[2], LIMITS.statePathsPerHome, 'path');
      return;
    }
    case Opcode.StateSnapshot: {
      const fields = exactTuple(payload, 3, 'STATE_SNAPSHOT');
      epoch(fields[0], 'STATE_SNAPSHOT.epoch');
      positiveId(fields[1], 'STATE_SNAPSHOT.revision');
      const entries = asArray(fields[2], 'STATE_SNAPSHOT.entries', LIMITS.statePathsPerHome);
      const ids = entries.map((entry, index) => exactTuple(entry, 2, `STATE_SNAPSHOT.entries[${index}]`)[0]!);
      uniqueIds(ids, 'STATE_SNAPSHOT.pathIds');
      return;
    }
    case Opcode.StatePatch: {
      const fields = exactTuple(payload, 4, 'STATE_PATCH');
      epoch(fields[0], 'STATE_PATCH.epoch');
      const base = positiveId(fields[1], 'STATE_PATCH.baseRevision');
      const revision = positiveId(fields[2], 'STATE_PATCH.revision');
      if (revision <= base) fail('invalid_frame', 'STATE_PATCH revision must advance');
      mutations(fields[3], 'STATE_PATCH.mutations');
      return;
    }
    case Opcode.StateSet: {
      const fields = exactTuple(payload, 3, 'STATE_SET');
      positiveId(fields[0], 'STATE_SET.requestId');
      epoch(fields[1], 'STATE_SET.epoch');
      mutations(fields[2], 'STATE_SET.mutations');
      return;
    }
    case Opcode.StateSetOk: {
      const fields = exactTuple(payload, 3, 'STATE_SET_OK');
      positiveId(fields[0], 'STATE_SET_OK.requestId');
      epoch(fields[1], 'STATE_SET_OK.epoch');
      positiveId(fields[2], 'STATE_SET_OK.revision');
      return;
    }
    case Opcode.StateAclSync: {
      const fields = exactTuple(payload, 2, 'STATE_ACL_SYNC');
      positiveId(fields[0], 'STATE_ACL_SYNC.requestId');
      const entries = asArray(fields[1], 'STATE_ACL_SYNC.declarations', LIMITS.declarationsPerCoordinator);
      const users = new Set<string>();
      entries.forEach((entry, index) => {
        const item = exactTuple(entry, 2, `STATE_ACL_SYNC.declarations[${index}]`);
        const user = opaqueId(item[0], `STATE_ACL_SYNC.declarations[${index}].userId`);
        if (users.has(user)) fail('invalid_frame', 'STATE_ACL_SYNC contains a duplicate user');
        users.add(user);
        aclPatterns(item[1], `STATE_ACL_SYNC.declarations[${index}].patterns`);
      });
      return;
    }
    case Opcode.StateAclOk: {
      const fields = exactTuple(payload, 2, 'STATE_ACL_OK');
      positiveId(fields[0], 'STATE_ACL_OK.requestId');
      positiveId(fields[1], 'STATE_ACL_OK.policyRevision');
      return;
    }
    case Opcode.StateResync: {
      const fields = exactTuple(payload, 1, 'STATE_RESYNC');
      positiveId(fields[0], 'STATE_RESYNC.requestId');
      return;
    }
    case Opcode.EventSync: {
      const fields = exactTuple(payload, 2, 'EVENT_SYNC');
      positiveId(fields[0], 'EVENT_SYNC.requestId');
      const entries = asArray(fields[1], 'EVENT_SYNC.declarations', LIMITS.declarationsPerCoordinator);
      const topics = new Set<string>();
      entries.forEach((entry, index) => {
        const item = exactTuple(entry, 2, `EVENT_SYNC.declarations[${index}]`);
        const topic = structuredName(item[0], `EVENT_SYNC.declarations[${index}].topic`);
        if (topics.has(topic)) fail('invalid_frame', 'EVENT_SYNC contains a duplicate topic');
        topics.add(topic);
        integer(item[1], 1, 0x0f, `EVENT_SYNC.declarations[${index}].flags`);
      });
      return;
    }
    case Opcode.EventSyncOk: {
      const fields = exactTuple(payload, 2, 'EVENT_SYNC_OK');
      positiveId(fields[0], 'EVENT_SYNC_OK.requestId');
      dictionary(fields[1], LIMITS.declarationsPerCoordinator, 'topic');
      return;
    }
    case Opcode.TopicDict: {
      const fields = exactTuple(payload, 3, 'TOPIC_DICT');
      epoch(fields[0], 'TOPIC_DICT.epoch');
      booleanValue(fields[1], 'TOPIC_DICT.replace');
      dictionary(fields[2], LIMITS.statePathsPerHome, 'topic');
      return;
    }
    case Opcode.EventAclSync: {
      const fields = exactTuple(payload, 2, 'EVENT_ACL_SYNC');
      positiveId(fields[0], 'EVENT_ACL_SYNC.requestId');
      const entries = asArray(fields[1], 'EVENT_ACL_SYNC.declarations', LIMITS.declarationsPerCoordinator);
      const users = new Set<string>();
      entries.forEach((entry, index) => {
        const item = exactTuple(entry, 3, `EVENT_ACL_SYNC.declarations[${index}]`);
        const user = opaqueId(item[0], `EVENT_ACL_SYNC.declarations[${index}].userId`);
        if (users.has(user)) fail('invalid_frame', 'EVENT_ACL_SYNC contains a duplicate user');
        users.add(user);
        aclPatterns(item[1], `EVENT_ACL_SYNC.declarations[${index}].publishPatterns`);
        aclPatterns(item[2], `EVENT_ACL_SYNC.declarations[${index}].subscribePatterns`);
      });
      return;
    }
    case Opcode.EventAclOk: {
      const fields = exactTuple(payload, 2, 'EVENT_ACL_OK');
      positiveId(fields[0], 'EVENT_ACL_OK.requestId');
      positiveId(fields[1], 'EVENT_ACL_OK.policyRevision');
      return;
    }
    case Opcode.Subscribe:
      return subscriptionPayload(payload, 'SUBSCRIBE');
    case Opcode.SubscribeOk:
      return subscriptionPayload(payload, 'SUBSCRIBE_OK');
    case Opcode.Unsubscribe:
      return subscriptionPayload(payload, 'UNSUBSCRIBE');
    case Opcode.UnsubscribeOk:
      return subscriptionPayload(payload, 'UNSUBSCRIBE_OK');
    case Opcode.Event: {
      if (payload.length !== 5 && payload.length !== 6) fail('invalid_frame', 'EVENT has wrong arity');
      positiveId(payload[0], 'EVENT.eventId');
      positiveId(payload[1], 'EVENT.topicId');
      target(payload[2], payload[3], 'EVENT.target');
      if (payload.length === 6) principal(payload[4], 'EVENT.source');
      return;
    }
    case Opcode.FunctionSync: {
      const fields = exactTuple(payload, 2, 'FUNCTION_SYNC');
      positiveId(fields[0], 'FUNCTION_SYNC.requestId');
      const names = asArray(fields[1], 'FUNCTION_SYNC.names', LIMITS.declarationsPerCoordinator);
      uniqueStrings(names, structuredName, 'FUNCTION_SYNC.names');
      return;
    }
    case Opcode.FunctionSyncOk: {
      const fields = exactTuple(payload, 2, 'FUNCTION_SYNC_OK');
      positiveId(fields[0], 'FUNCTION_SYNC_OK.requestId');
      dictionary(fields[1], LIMITS.declarationsPerCoordinator, 'function');
      return;
    }
    case Opcode.FunctionDict: {
      const fields = exactTuple(payload, 3, 'FUNCTION_DICT');
      epoch(fields[0], 'FUNCTION_DICT.epoch');
      booleanValue(fields[1], 'FUNCTION_DICT.replace');
      dictionary(fields[2], LIMITS.statePathsPerHome, 'function');
      return;
    }
    case Opcode.Call: {
      const fields = exactTuple(payload, 8, 'CALL');
      positiveId(fields[0], 'CALL.callId');
      target(fields[1], fields[2], 'CALL.target');
      positiveId(fields[3], 'CALL.functionId');
      integer(fields[4], 1, LIMITS.callTimeoutMs, 'CALL.timeoutMs');
      nullableString(fields[5], 128, 'CALL.idempotencyKey');
      integer(fields[6], 0, LIMITS.streamCredit, 'CALL.initialCredit');
      return;
    }
    case Opcode.CallDispatch: {
      const fields = exactTuple(payload, 9, 'CALL_DISPATCH');
      positiveId(fields[0], 'CALL_DISPATCH.callId');
      principal(fields[1], 'CALL_DISPATCH.source');
      target(fields[2], fields[3], 'CALL_DISPATCH.target');
      positiveId(fields[4], 'CALL_DISPATCH.functionId');
      integer(fields[5], 1, LIMITS.callTimeoutMs, 'CALL_DISPATCH.timeoutMs');
      nullableString(fields[6], 128, 'CALL_DISPATCH.idempotencyKey');
      integer(fields[7], 0, LIMITS.streamCredit, 'CALL_DISPATCH.initialCredit');
      return;
    }
    case Opcode.CallAccepted: {
      const fields = exactTuple(payload, 1, 'CALL_ACCEPTED');
      positiveId(fields[0], 'CALL_ACCEPTED.callId');
      return;
    }
    case Opcode.CallResult: {
      const fields = exactTuple(payload, 3, 'CALL_RESULT');
      positiveId(fields[0], 'CALL_RESULT.callId');
      booleanValue(fields[1], 'CALL_RESULT.final');
      return;
    }
    case Opcode.CallError: {
      const fields = exactTuple(payload, 5, 'CALL_ERROR');
      positiveId(fields[0], 'CALL_ERROR.callId');
      callErrorCode(fields[1], 'CALL_ERROR.code');
      booleanValue(fields[2], 'CALL_ERROR.retryable');
      stringValue(fields[3], 1, 256, 'CALL_ERROR.message');
      return;
    }
    case Opcode.CallCancel: {
      const fields = exactTuple(payload, 2, 'CALL_CANCEL');
      positiveId(fields[0], 'CALL_CANCEL.callId');
      integer(fields[1], 0, 0xffff, 'CALL_CANCEL.reasonCode');
      return;
    }
    case Opcode.CallCredit: {
      const fields = exactTuple(payload, 2, 'CALL_CREDIT');
      positiveId(fields[0], 'CALL_CREDIT.callId');
      integer(fields[1], 1, LIMITS.streamCredit, 'CALL_CREDIT.additionalCredit');
      return;
    }
    case Opcode.PresenceSnapshot: {
      const fields = exactTuple(payload, 1, 'PRESENCE_SNAPSHOT');
      const entries = asArray(fields[0], 'PRESENCE_SNAPSHOT.entries');
      const sessions = new Set<number>();
      entries.forEach((entry, index) => {
        const item = exactTuple(entry, 2, `PRESENCE_SNAPSHOT.entries[${index}]`);
        const session = positiveId(item[0], `PRESENCE_SNAPSHOT.entries[${index}].sessionId`);
        if (sessions.has(session)) fail('invalid_frame', 'PRESENCE_SNAPSHOT contains a duplicate session');
        sessions.add(session);
        opaqueId(item[1], `PRESENCE_SNAPSHOT.entries[${index}].userId`);
      });
      return;
    }
    case Opcode.PresenceChange: {
      const fields = exactTuple(payload, 3, 'PRESENCE_CHANGE');
      positiveId(fields[0], 'PRESENCE_CHANGE.sessionId');
      opaqueId(fields[1], 'PRESENCE_CHANGE.userId');
      integer(fields[2], 1, 2, 'PRESENCE_CHANGE.event');
      return;
    }
    default:
      return fail('unknown_opcode', 'unknown core opcode');
  }
}

function preflight(input: Uint8Array): void {
  if (input.length > LIMITS.frameBytes) fail('frame_too_large', 'frame exceeds byte limit');
  if (input.length < 2) fail('malformed', 'frame is missing its payload');
  const result = scanValue(input, 1, 1, { nodes: 0 });
  if (result.kind !== 'array') fail('invalid_frame', 'frame payload must be an array');
  if (result.end !== input.length) fail('malformed', 'frame has trailing bytes');
}

export function encodeFrame(frame: Frame): Uint8Array {
  if (!Number.isInteger(frame.opcode) || frame.opcode < 0 || frame.opcode > 0xff) {
    fail('unknown_opcode', 'opcode must be one byte');
  }
  validateFrame(frame);
  const payload = encodeValue(frame.payload, 1, { nodes: 0, bytes: 0 });
  const output = concat([byte(frame.opcode), payload]);
  preflight(output);
  return output;
}

export function decodeFrame(input: Uint8Array): Frame {
  preflight(input);
  const opcode = input[0]!;
  if (opcode < 0x80 && !KNOWN_CORE_OPCODES.has(opcode)) {
    fail('unknown_opcode', `unknown core opcode 0x${opcode.toString(16)}`);
  }
  let payload: unknown;
  try {
    payload = decode(input.subarray(1), {
      useBigInt64: false,
      maxStrLength: LIMITS.stringBytes,
      maxBinLength: LIMITS.binaryBytes,
      maxArrayLength: LIMITS.arrayItems,
      maxMapLength: LIMITS.mapEntries,
      maxExtLength: 0,
    });
  } catch (error) {
    fail('malformed', `MessagePack decoder rejected a preflighted payload: ${String(error)}`);
  }
  const frame: Frame = { opcode, payload: asArray(payload, 'frame payload') };
  validateFrame(frame);
  return frame;
}
