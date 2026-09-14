/**
 * Strict JSON decoding for control-plane responses.
 *
 * The SDK keeps an equivalent parser for the access-token exchange, but its
 * value and string ceilings are tuned to that one response. Publication
 * responses carry the closed RFC 0002 `requires` object, so this parser applies
 * the general RFC 0004 §4.2 limits instead. Both reject duplicate keys,
 * prototype-polluting keys, trailing content and non-UTF-8 input; neither
 * accepts an unknown field anywhere an exact shape is expected.
 */
const MAXIMUM_DEPTH = 16;
const MAXIMUM_VALUES = 2_048;
const MAXIMUM_STRING_BYTES = 16_384;
const UTF8 = new TextEncoder();
const CONTROL_CHARACTER = /\p{Cc}/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class InvalidJsonError extends Error {
  constructor() {
    super('Invalid control-plane JSON');
    this.name = 'InvalidJsonError';
  }
}

function invalid(): never {
  throw new InvalidJsonError();
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function parseJson(input: Uint8Array): JsonValue {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return invalid();
  }
  let index = 0;
  let values = 0;

  const skipWhitespace = (): void => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      index += 1;
    }
  };

  const parseString = (): string => {
    if (text[index] !== '"') return invalid();
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      if (!escaped && character === '"') {
        index += 1;
        let decoded: unknown;
        try {
          decoded = JSON.parse(text.slice(start, index)) as unknown;
        } catch {
          return invalid();
        }
        if (typeof decoded !== 'string'
          || hasUnpairedSurrogate(decoded)
          || UTF8.encode(decoded).byteLength > MAXIMUM_STRING_BYTES) return invalid();
        return decoded;
      }
      escaped = !escaped && character === '\\';
      index += 1;
    }
    return invalid();
  };

  const parseValue = (depth: number): JsonValue => {
    if (depth > MAXIMUM_DEPTH) return invalid();
    values += 1;
    if (values > MAXIMUM_VALUES) return invalid();
    skipWhitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      const match = NUMBER.exec(text.slice(index));
      if (match === null) return invalid();
      index += match[0].length;
      const number = Number(match[0]);
      if (!Number.isFinite(number)) return invalid();
      return number;
    }
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    if (character === '[') {
      index += 1;
      const items: JsonValue[] = [];
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return items;
      }
      while (true) {
        items.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return items;
        }
        if (text[index] !== ',') return invalid();
        index += 1;
        skipWhitespace();
      }
    }
    if (character === '{') {
      index += 1;
      const record = Object.create(null) as { [key: string]: JsonValue };
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return record;
      }
      while (true) {
        const key = parseString();
        if (keys.has(key) || FORBIDDEN_KEYS.has(key)) return invalid();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') return invalid();
        index += 1;
        record[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return record;
        }
        if (text[index] !== ',') return invalid();
        index += 1;
        skipWhitespace();
      }
    }
    return invalid();
  };

  skipWhitespace();
  const parsed = parseValue(1);
  skipWhitespace();
  if (index !== text.length) return invalid();
  return parsed;
}

/** Accepts only the exact declared key set: an unknown field is a rejection. */
export function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return invalid();
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).length !== keys.length
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))) return invalid();
  return value as Readonly<Record<string, unknown>>;
}

export function boundedString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string'
    || hasUnpairedSurrogate(value)
    || CONTROL_CHARACTER.test(value)) return invalid();
  const bytes = UTF8.encode(value).byteLength;
  if (bytes < minimum || bytes > maximum) return invalid();
  return value;
}

export function stringArray(value: unknown, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) return invalid();
  return value.map((item) => {
    if (typeof item !== 'string') return invalid();
    return item;
  });
}

export function positiveInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum) return invalid();
  return value;
}

/** RFC 3339 instant as produced by the control plane; compared as an exact string. */
export function instant(value: unknown): string {
  const text = boundedString(value, 20, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return invalid();
  return text;
}
