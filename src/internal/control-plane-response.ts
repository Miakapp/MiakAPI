const MAXIMUM_RESPONSE_BYTES = 65_536;
const MAXIMUM_JSON_DEPTH = 8;
const MAXIMUM_JSON_VALUES = 128;
const MAXIMUM_JSON_STRING_BYTES = 16_384;
const MAXIMUM_JSON_OBJECT_ENTRIES = 32;
const MAXIMUM_JSON_ARRAY_ITEMS = 32;
const CONTROL_CHARACTER = /\p{Cc}/u;
const UTF8 = new TextEncoder();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function invalidResponse(): never {
  throw new TypeError('Invalid control-plane response');
}

export function cancelResponseBody(response: Response | undefined): void {
  try {
    const cancellation = response?.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // Rejection still wins even if a custom Fetch implementation exposes a hostile body.
  }
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

export function exactResponseRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return invalidResponse();
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).length !== keys.length
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))) return invalidResponse();
  return value as Readonly<Record<string, unknown>>;
}

export function boundedResponseString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string'
    || hasUnpairedSurrogate(value)
    || CONTROL_CHARACTER.test(value)) return invalidResponse();
  const bytes = UTF8.encode(value).byteLength;
  if (bytes < minimum || bytes > maximum) return invalidResponse();
  return value;
}

export function canonicalRelayUrl(value: unknown): string {
  const relayUrl = boundedResponseString(value, 1, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return invalidResponse();
  }
  if (parsed.protocol !== 'wss:'
    || parsed.hostname === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !parsed.pathname.endsWith('/ws')
    || parsed.href !== relayUrl) return invalidResponse();
  return relayUrl;
}

export function parseResponseJson(input: Uint8Array): JsonValue {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return invalidResponse();
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
    if (text[index] !== '"') return invalidResponse();
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
          return invalidResponse();
        }
        if (typeof decoded !== 'string'
          || hasUnpairedSurrogate(decoded)
          || UTF8.encode(decoded).byteLength > MAXIMUM_JSON_STRING_BYTES) {
          return invalidResponse();
        }
        return decoded;
      }
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      index += 1;
    }
    return invalidResponse();
  };
  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (match === null) return invalidResponse();
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) return invalidResponse();
    return number;
  };
  const parseValue = (depth: number): JsonValue => {
    if (depth > MAXIMUM_JSON_DEPTH) return invalidResponse();
    values += 1;
    if (values > MAXIMUM_JSON_VALUES) return invalidResponse();
    skipWhitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      return parseNumber();
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
      const result: JsonValue[] = [];
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      while (true) {
        if (result.length >= MAXIMUM_JSON_ARRAY_ITEMS) return invalidResponse();
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return result;
        }
        if (text[index] !== ',') return invalidResponse();
        index += 1;
        skipWhitespace();
      }
    }
    if (character === '{') {
      index += 1;
      const result = Object.create(null) as { [key: string]: JsonValue };
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      while (true) {
        if (keys.size >= MAXIMUM_JSON_OBJECT_ENTRIES) return invalidResponse();
        const key = parseString();
        if (keys.has(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
          return invalidResponse();
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') return invalidResponse();
        index += 1;
        result[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return result;
        }
        if (text[index] !== ',') return invalidResponse();
        index += 1;
        skipWhitespace();
      }
    }
    return invalidResponse();
  };

  skipWhitespace();
  const parsed = parseValue(1);
  skipWhitespace();
  if (index !== text.length) return invalidResponse();
  return parsed;
}

export async function boundedResponseBody(
  response: Response,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)
      || Number(contentLength) > MAXIMUM_RESPONSE_BYTES)) {
    cancelResponseBody(response);
    return invalidResponse();
  }
  if (response.body === null) return invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The caller's validation or cancellation result remains authoritative.
    }
  };
  if (signal !== undefined) {
    signal.addEventListener('abort', cancelReader, { once: true });
    if (signal.aborted) cancelReader();
  }
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        cancelReader();
        return invalidResponse();
      }
      chunks.push(item.value);
    }
  } catch {
    return invalidResponse();
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
  if (size === 0) return invalidResponse();
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
