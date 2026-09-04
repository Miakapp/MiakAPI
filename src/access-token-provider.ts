import type {
  AccessToken,
  AccessTokenProvider,
  AccessTokenRequest,
} from './api.js';
import {
  boundedResponseBody,
  boundedResponseString,
  cancelResponseBody,
  canonicalRelayUrl,
  parseResponseJson,
  type JsonValue,
} from './internal/control-plane-response.js';

const MAXIMUM_ACCESS_TOKEN_BYTES = 8_192;
const MAXIMUM_ACCESS_TOKEN_LIFETIME_MS = 330_000;
const HOME_KEY = /^mhk1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const COORDINATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function accessTokenResponse(value: JsonValue, keyId: string, now: number): AccessToken {
  const response = exactRecord(value, [
    'schema', 'access_token', 'token_type', 'expires_at_ms', 'relay_url', 'key',
  ], []);
  const key = exactRecord(response.key, ['id', 'label'], []);
  const accessToken = boundedResponseString(response.access_token, 1, MAXIMUM_ACCESS_TOKEN_BYTES);
  if (response.schema !== 'miakapp.access-token/1'
    || response.token_type !== 'Bearer'
    || accessToken.split('.').length !== 3
    || !accessToken.split('.').every((segment) => BASE64URL.test(segment))
    || key.id !== keyId) return exchangeFailure();
  boundedResponseString(key.label, 1, 64);
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
          cancelResponseBody(response);
          throw request.signal.reason;
        }
        if (response.status !== 200) {
          cancelResponseBody(response);
          return exchangeFailure();
        }
        if (response.headers.get('cache-control') !== 'no-store'
          || response.headers.get('pragma') !== 'no-cache'
          || response.headers.get('referrer-policy') !== 'no-referrer'
          || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          cancelResponseBody(response);
          return exchangeFailure();
        }
        const body = await boundedResponseBody(response, request.signal);
        if (request.signal.aborted) throw request.signal.reason;
        return accessTokenResponse(parseResponseJson(body), homeKey.keyId, Date.now());
      } catch {
        if (request.signal.aborted) throw request.signal.reason;
        return exchangeFailure();
      }
    },
  });
}
