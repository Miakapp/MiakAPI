import type {
  BrowserRelayCredential,
  BrowserRelayCredentialProvider,
  BrowserRelayCredentialRequest,
  ControlPlaneBrowserRelayCredentialProviderOptions,
} from './browser-api.js';
import {
  boundedResponseBody,
  boundedResponseString,
  cancelResponseBody,
  canonicalRelayUrl,
  exactResponseRecord,
  parseResponseJson,
  type JsonValue,
} from './internal/control-plane-response.js';

const HOME_ID = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const GRAPHIC_ASCII = /^[\x21-\x7e]+$/;
const MAXIMUM_SOURCE_TOKEN_BYTES = 8_192;
const MAXIMUM_ACCESS_TOKEN_BYTES = 8_192;
const MAXIMUM_ACCESS_TOKEN_LIFETIME_MS = 330_000;
const UTF8 = new TextEncoder();

function exchangeFailure(): never {
  throw new Error('Miakapp browser relay credential exchange failed');
}

function plainExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      return exchangeFailure();
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Object.keys(value);
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    if ((prototype !== Object.prototype && prototype !== null)
      || ownKeys.length !== keys.length
      || required.some((key) => !Object.hasOwn(descriptors, key))
      || keys.some((key) => {
        const descriptor = descriptors[key];
        return !allowed.has(key)
          || descriptor === undefined
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, 'value');
      })) return exchangeFailure();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) result[key] = descriptors[key]?.value;
    return Object.freeze(result);
  } catch {
    return exchangeFailure();
  }
}

function canonicalExchangeEndpoint(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || UTF8.encode(value).byteLength > 2_048) return exchangeFailure();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return exchangeFailure();
  }
  if (parsed.protocol !== 'https:'
    || parsed.hostname === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname !== '/v1/user-relay-tokens:exchange'
    || parsed.href !== value) return exchangeFailure();
  return value;
}

function validateRequest(value: BrowserRelayCredentialRequest): BrowserRelayCredentialRequest {
  const request = plainExactRecord(value, ['homeId', 'reason', 'signal'], []);
  if (typeof request.homeId !== 'string'
    || !HOME_ID.test(request.homeId)
    || (request.reason !== 'initial'
      && request.reason !== 'reauth'
      && request.reason !== 'reconnect')
    || !(request.signal instanceof AbortSignal)) return exchangeFailure();
  return Object.freeze({
    homeId: request.homeId,
    reason: request.reason,
    signal: request.signal,
  });
}

function sourceToken(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAXIMUM_SOURCE_TOKEN_BYTES
    || !GRAPHIC_ASCII.test(value)) return exchangeFailure();
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some((segment) => !BASE64URL.test(segment))) {
    return exchangeFailure();
  }
  return value;
}

function credentialResponse(
  value: JsonValue,
  firebaseIdToken: string,
  appCheckToken: string,
  now: number,
): BrowserRelayCredential {
  const response = exactResponseRecord(value, [
    'schema', 'access_token', 'token_type', 'expires_at_ms', 'relay_url',
  ], []);
  const accessToken = boundedResponseString(
    response.access_token,
    1,
    MAXIMUM_ACCESS_TOKEN_BYTES,
  );
  const segments = accessToken.split('.');
  const expiresAtMs = response.expires_at_ms;
  if (response.schema !== 'miakapp.user-relay-token/1'
    || response.token_type !== 'Bearer'
    || segments.length !== 3
    || segments.some((segment) => !BASE64URL.test(segment))
    || accessToken === firebaseIdToken
    || accessToken === appCheckToken
    || typeof expiresAtMs !== 'number'
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= now
    || expiresAtMs > now + MAXIMUM_ACCESS_TOKEN_LIFETIME_MS) return exchangeFailure();
  return Object.freeze({
    relayUrl: canonicalRelayUrl(response.relay_url),
    accessToken,
    expiresAtMs,
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

async function exchangeCredential(
  endpoint: string,
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
  getFirebaseIdToken: (request: BrowserRelayCredentialRequest) => Promise<string>,
  getAppCheckToken: (request: BrowserRelayCredentialRequest) => Promise<string>,
  request: BrowserRelayCredentialRequest,
): Promise<BrowserRelayCredential> {
  let response: Response | undefined;
  try {
    const firebaseIdToken = sourceToken(await withAbort(
      Promise.resolve().then(() => getFirebaseIdToken(request)),
      request.signal,
    ));
    const appCheckToken = sourceToken(await withAbort(
      Promise.resolve().then(() => getAppCheckToken(request)),
      request.signal,
    ));
    if (firebaseIdToken === appCheckToken) return exchangeFailure();
    response = await withAbort(fetcher(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${firebaseIdToken}`,
        'content-type': 'application/json',
        'x-firebase-appcheck': appCheckToken,
      },
      body: JSON.stringify({ home_id: request.homeId, reason: request.reason }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: request.signal,
    } as RequestInit), request.signal);
    if (request.signal.aborted) throw abortReason(request.signal);
    if (response.status !== 200 || response.redirected || response.type === 'opaqueredirect') {
      cancelResponseBody(response);
      return exchangeFailure();
    }
    if (response.headers.get('cache-control') !== 'no-store'
      || response.headers.get('pragma') !== 'no-cache'
      || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        !== 'application/json') {
      cancelResponseBody(response);
      return exchangeFailure();
    }
    const body = await withAbort(boundedResponseBody(response, request.signal), request.signal);
    if (request.signal.aborted) throw abortReason(request.signal);
    return credentialResponse(parseResponseJson(body), firebaseIdToken, appCheckToken, Date.now());
  } catch {
    if (request.signal.aborted) {
      cancelResponseBody(response);
      throw abortReason(request.signal);
    }
    return exchangeFailure();
  }
}

export function createControlPlaneBrowserRelayCredentialProvider(
  value: ControlPlaneBrowserRelayCredentialProviderOptions,
): BrowserRelayCredentialProvider {
  let endpoint: string;
  let getFirebaseIdToken: (request: BrowserRelayCredentialRequest) => Promise<string>;
  let getAppCheckToken: (request: BrowserRelayCredentialRequest) => Promise<string>;
  let fetcher: (input: string, init: RequestInit) => Promise<Response>;
  try {
    const options = plainExactRecord(
      value,
      ['exchangeEndpoint', 'getFirebaseIdToken', 'getAppCheckToken'],
      ['fetch'],
    );
    endpoint = canonicalExchangeEndpoint(options.exchangeEndpoint);
    if (typeof options.getFirebaseIdToken !== 'function'
      || typeof options.getAppCheckToken !== 'function'
      || (options.fetch !== undefined && typeof options.fetch !== 'function')) {
      return exchangeFailure();
    }
    getFirebaseIdToken = options.getFirebaseIdToken as
      (request: BrowserRelayCredentialRequest) => Promise<string>;
    getAppCheckToken = options.getAppCheckToken as
      (request: BrowserRelayCredentialRequest) => Promise<string>;
    const selectedFetch = (options.fetch ?? globalThis.fetch) as
      ((input: string, init: RequestInit) => Promise<Response>) | undefined;
    if (typeof selectedFetch !== 'function') return exchangeFailure();
    fetcher = selectedFetch;
  } catch {
    return exchangeFailure();
  }
  const inflight = new WeakMap<AbortSignal, Map<string, Promise<BrowserRelayCredential>>>();

  return Object.freeze({
    getCredential(valueRequest: BrowserRelayCredentialRequest): Promise<BrowserRelayCredential> {
      let request: BrowserRelayCredentialRequest;
      try {
        request = validateRequest(valueRequest);
      } catch {
        return Promise.reject(new Error('Miakapp browser relay credential exchange failed'));
      }
      if (request.signal.aborted) return Promise.reject(abortReason(request.signal));
      const key = `${request.homeId}\u0000${request.reason}`;
      let requests = inflight.get(request.signal);
      if (requests === undefined) {
        requests = new Map();
        inflight.set(request.signal, requests);
      }
      const existing = requests.get(key);
      if (existing !== undefined) return existing;
      const pending = exchangeCredential(
        endpoint,
        fetcher,
        getFirebaseIdToken,
        getAppCheckToken,
        request,
      );
      requests.set(key, pending);
      void pending.finally(() => {
        if (requests?.get(key) === pending) requests.delete(key);
      }).catch(() => undefined);
      return pending;
    },
  });
}
