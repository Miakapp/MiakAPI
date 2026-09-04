import type {
  AccessToken,
  AccessTokenProvider,
  AccessTokenRequest,
} from './api.js';

const MAXIMUM_RESPONSE_BYTES = 65_536;
const MAXIMUM_JSON_DEPTH = 8;
const MAXIMUM_JSON_VALUES = 128;
const MAXIMUM_JSON_STRING_BYTES = 16_384;
const MAXIMUM_JSON_OBJECT_ENTRIES = 32;
const MAXIMUM_JSON_ARRAY_ITEMS = 32;
const MAXIMUM_ACCESS_TOKEN_BYTES = 8_192;
const MAXIMUM_ACCESS_TOKEN_LIFETIME_MS = 330_000;
const HOME_KEY = /^mhk1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const COORDINATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const UTF8 = new TextEncoder();

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface HomeKeyAccessTokenProviderOptions {
  readonly exchangeEndpoint: string;
  readonly homeKey: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

function exchangeFailure(): never {
  throw new Error('Miakapp access-token exchange failed');
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return exchangeFailure();
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))) return exchangeFailure();
  return value as Readonly<Record<string, unknown>>;
}

function canonicalExchangeEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return exchangeFailure();
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return exchangeFailure();
  }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname !== '/v1/access-tokens:exchange'
    || parsed.href !== value) return exchangeFailure();
  return value;
}

function decodeCanonicalBase64URL(value: string, bytes: number): boolean {
  if (!BASE64URL.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === bytes && decoded.toString('base64url') === value;
}

function validHomeKey(value: unknown): { value: string; keyId: string } {
  if (typeof value !== 'string') return exchangeFailure();
  const match = HOME_KEY.exec(value);
  if (match === null
    || match[1] === undefined
    || match[2] === undefined
    || !decodeCanonicalBase64URL(match[1], 16)
    || !decodeCanonicalBase64URL(match[2], 32)) return exchangeFailure();
  return { value, keyId: match[1] };
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

function parseResponseJson(input: Uint8Array): JsonValue {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return exchangeFailure();
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
    if (text[index] !== '"') return exchangeFailure();
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
          return exchangeFailure();
        }
        if (typeof decoded !== 'string'
          || hasUnpairedSurrogate(decoded)
          || UTF8.encode(decoded).byteLength > MAXIMUM_JSON_STRING_BYTES) {
          return exchangeFailure();
        }
        return decoded;
      }
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      index += 1;
    }
    return exchangeFailure();
  };
  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (match === null) return exchangeFailure();
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) return exchangeFailure();
    return number;
  };
  const parseValue = (depth: number): JsonValue => {
    if (depth > MAXIMUM_JSON_DEPTH) return exchangeFailure();
    values += 1;
    if (values > MAXIMUM_JSON_VALUES) return exchangeFailure();
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
        if (result.length >= MAXIMUM_JSON_ARRAY_ITEMS) return exchangeFailure();
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return result;
        }
        if (text[index] !== ',') return exchangeFailure();
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
        if (keys.size >= MAXIMUM_JSON_OBJECT_ENTRIES) return exchangeFailure();
        const key = parseString();
        if (keys.has(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
          return exchangeFailure();
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') return exchangeFailure();
        index += 1;
        result[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return result;
        }
        if (text[index] !== ',') return exchangeFailure();
        index += 1;
        skipWhitespace();
      }
    }
    return exchangeFailure();
  };

  skipWhitespace();
  const parsed = parseValue(1);
  skipWhitespace();
  if (index !== text.length) return exchangeFailure();
  return parsed;
}

async function boundedResponseBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)
      || Number(contentLength) > MAXIMUM_RESPONSE_BYTES)) return exchangeFailure();
  if (response.body === null) return exchangeFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return exchangeFailure();
      }
      chunks.push(item.value);
    }
  } catch {
    return exchangeFailure();
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return exchangeFailure();
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function boundedSafeString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string'
    || hasUnpairedSurrogate(value)
    || CONTROL_CHARACTER.test(value)) return exchangeFailure();
  const bytes = UTF8.encode(value).byteLength;
  if (bytes < minimum || bytes > maximum) return exchangeFailure();
  return value;
}

function canonicalRelayUrl(value: unknown): string {
  const relayUrl = boundedSafeString(value, 1, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return exchangeFailure();
  }
  if (parsed.protocol !== 'wss:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !parsed.pathname.endsWith('/ws')
    || parsed.href !== relayUrl) return exchangeFailure();
  return relayUrl;
}

function accessTokenResponse(value: JsonValue, keyId: string, now: number): AccessToken {
  const response = exactRecord(value, [
    'schema', 'access_token', 'token_type', 'expires_at_ms', 'relay_url', 'key',
  ], []);
  const key = exactRecord(response.key, ['id', 'label'], []);
  const accessToken = boundedSafeString(response.access_token, 1, MAXIMUM_ACCESS_TOKEN_BYTES);
  if (response.schema !== 'miakapp.access-token/1'
    || response.token_type !== 'Bearer'
    || accessToken.split('.').length !== 3
    || !accessToken.split('.').every((segment) => BASE64URL.test(segment))
    || key.id !== keyId) return exchangeFailure();
  boundedSafeString(key.label, 1, 64);
  const expiresAtMs = response.expires_at_ms;
  if (typeof expiresAtMs !== 'number'
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= now
    || expiresAtMs > now + MAXIMUM_ACCESS_TOKEN_LIFETIME_MS) return exchangeFailure();
  return Object.freeze({
    relayUrl: canonicalRelayUrl(response.relay_url),
    token: accessToken,
    expiresAtMs,
  });
}

function validateTokenRequest(value: AccessTokenRequest): void {
  const request = exactRecord(
    value,
    ['coordinatorName', 'reason', 'signal'],
    ['relayHost'],
  );
  if (typeof request.coordinatorName !== 'string'
    || !COORDINATOR_NAME.test(request.coordinatorName)
    || (request.reason !== 'initial' && request.reason !== 'reauth' && request.reason !== 'reconnect')
    || request.signal === null
    || typeof request.signal !== 'object'
    || !('aborted' in request.signal)
    || !('addEventListener' in request.signal)
    || (request.relayHost !== undefined
      && (typeof request.relayHost !== 'string' || request.relayHost.length === 0 || request.relayHost.length > 255))) {
    return exchangeFailure();
  }
}

// createHomeKeyAccessTokenProvider maps the RFC 0004 Home Key exchange onto
// MiakAPI's three-field access-token boundary. It performs exactly one request
// per SDK demand and never exposes the Home Key to the WebSocket layer.
export function createHomeKeyAccessTokenProvider(
  value: HomeKeyAccessTokenProviderOptions,
): AccessTokenProvider {
  const options = exactRecord(value, ['exchangeEndpoint', 'homeKey'], ['fetch']);
  const endpoint = canonicalExchangeEndpoint(options.exchangeEndpoint);
  const homeKey = validHomeKey(options.homeKey);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return exchangeFailure();

  return Object.freeze({
    async getAccessToken(request: AccessTokenRequest): Promise<AccessToken> {
      validateTokenRequest(request);
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${homeKey.value}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            purpose: 'relay',
            role: 'coordinator',
            coordinator_name: request.coordinatorName,
            reason: request.reason,
          }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: request.signal,
        });
      } catch {
        if (request.signal.aborted) throw request.signal.reason;
        return exchangeFailure();
      }
      try {
        if (request.signal.aborted) {
          await response.body?.cancel().catch(() => undefined);
          throw request.signal.reason;
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return exchangeFailure();
        }
        if (response.headers.get('cache-control') !== 'no-store'
          || response.headers.get('pragma') !== 'no-cache'
          || response.headers.get('referrer-policy') !== 'no-referrer'
          || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          await response.body?.cancel().catch(() => undefined);
          return exchangeFailure();
        }
        const body = await boundedResponseBody(response);
        if (request.signal.aborted) throw request.signal.reason;
        return accessTokenResponse(parseResponseJson(body), homeKey.keyId, Date.now());
      } catch {
        if (request.signal.aborted) throw request.signal.reason;
        return exchangeFailure();
      }
    },
  });
}
