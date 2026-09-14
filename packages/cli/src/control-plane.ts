import { authorizationError, contractError } from './errors.js';
import {
  canonicalHttpsUrl,
  cancelBody,
  readBoundedBody,
  requestBody,
  type FetchLike,
} from './internal/http.js';
import { boundedString, exactRecord, parseJson } from './internal/json.js';

/** RFC 0004 §3 caps the discovery document at 4 KiB. */
const MAXIMUM_DISCOVERY_BYTES = 4_096;

/** RFC 0004 §7 leases every access token for at most five minutes. */
const MAXIMUM_TOKEN_LIFETIME_MS = 330_000;

const HOME_KEY = /^mhk1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const DISCOVERY_PATH = '/.well-known/miakapp-control-plane';

export interface Discovery {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly exchangeEndpoint: string;
  readonly userRelayExchangeEndpoint: string;
  readonly pushAudience: string;
  readonly componentsAudience: string;
}

export interface PublisherToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  readonly keyId: string;
  readonly keyLabel: string;
}

export interface ControlPlaneOptions {
  readonly issuer: string;
  readonly fetch?: FetchLike;
}

export function homeKeyId(homeKey: string): string {
  const match = HOME_KEY.exec(homeKey);
  const keyId = match?.[1];
  if (keyId === undefined) {
    throw authorizationError(
      'The Home Key is not a valid mhk1 credential',
      'Create a new Home Key with the components:publish scope and store it outside Git.',
    );
  }
  return keyId;
}

/**
 * Reads the pinned deployment profile. The CLI never follows an issuer, JWKS URL
 * or audience supplied by a token: only this document, fetched from the issuer
 * the operator configured, selects endpoints.
 */
export async function fetchDiscovery(options: ControlPlaneOptions): Promise<Discovery> {
  const issuer = canonicalHttpsUrl(options.issuer, 'issuer');
  if (issuer.endsWith('/')) throw contractError('issuer must not have a trailing slash');
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(`${issuer}${DISCOVERY_PATH}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (response.status !== 200) {
    cancelBody(response);
    throw contractError(`Discovery document returned HTTP ${response.status}`);
  }
  const body = await readBoundedBody(response, MAXIMUM_DISCOVERY_BYTES);
  const document = exactRecord(parseJson(body), [
    'schema',
    'issuer',
    'jwks_uri',
    'exchange_endpoint',
    'user_relay_exchange_endpoint',
    'push_audience',
    'components_audience',
  ]);
  if (document.schema !== 'miakapp.control-plane-discovery/1') {
    throw contractError('Discovery document has an unsupported schema');
  }
  if (document.issuer !== issuer) {
    throw contractError('Discovery document advertises a different issuer');
  }
  return Object.freeze({
    issuer,
    jwksUri: canonicalHttpsUrl(document.jwks_uri, 'jwks_uri'),
    exchangeEndpoint: canonicalHttpsUrl(document.exchange_endpoint, 'exchange_endpoint'),
    userRelayExchangeEndpoint: canonicalHttpsUrl(
      document.user_relay_exchange_endpoint,
      'user_relay_exchange_endpoint',
    ),
    pushAudience: canonicalHttpsUrl(document.push_audience, 'push_audience'),
    componentsAudience: canonicalHttpsUrl(document.components_audience, 'components_audience'),
  });
}

/**
 * Exchanges a Home Key for the five-minute `components:publish` profile.
 *
 * RFC 0004 §7.2 attenuates the issued token to exactly that one scope, and
 * §7.3 omits `relay_url` for this purpose: a component token is useless at a
 * relay. Publication APIs never accept the Home Key itself.
 */
export async function exchangePublisherToken(
  discovery: Discovery,
  homeKey: string,
  options: { readonly fetch?: FetchLike } = {},
): Promise<PublisherToken> {
  const keyId = homeKeyId(homeKey);
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(discovery.exchangeEndpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${homeKey}`,
      'content-type': 'application/json',
    },
    body: requestBody({ purpose: 'components' }),
    // No request-side `cache` hint: Node and Bun have no HTTP cache to opt out
    // of, and the response-side no-store headers checked below are the actual
    // guarantee that this token is never stored by an intermediary.
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (response.status !== 200) {
    cancelBody(response);
    throw authorizationError(
      `Component token exchange returned HTTP ${response.status}`,
      'Confirm the Home Key exists, is not revoked and holds the components:publish scope.',
    );
  }
  if (response.headers.get('cache-control') !== 'no-store'
    || response.headers.get('pragma') !== 'no-cache'
    || response.headers.get('referrer-policy') !== 'no-referrer') {
    cancelBody(response);
    throw contractError('Component token response is missing its required no-store headers');
  }
  const body = await readBoundedBody(response, 65_536);
  const document = exactRecord(parseJson(body), [
    'schema',
    'access_token',
    'token_type',
    'expires_at_ms',
    'key',
  ]);
  const key = exactRecord(document.key, ['id', 'label']);
  const accessToken = boundedString(document.access_token, 1, 8_192);
  const expiresAtMs = document.expires_at_ms;
  if (document.schema !== 'miakapp.access-token/1'
    || document.token_type !== 'Bearer'
    || accessToken.split('.').length !== 3
    || typeof expiresAtMs !== 'number'
    || !Number.isSafeInteger(expiresAtMs)
    || key.id !== keyId) {
    throw contractError('Component token response does not match the closed exchange schema');
  }
  const now = Date.now();
  if (expiresAtMs <= now || expiresAtMs - now > MAXIMUM_TOKEN_LIFETIME_MS) {
    throw contractError('Component token lease is expired or longer than the five-minute ceiling');
  }
  return Object.freeze({
    accessToken,
    expiresAtMs,
    keyId,
    keyLabel: boundedString(key.label, 1, 64),
  });
}
