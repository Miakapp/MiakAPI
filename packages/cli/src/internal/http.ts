import { contractError } from '../errors.js';
import { parseJson, type JsonValue } from './json.js';

/** RFC 0004 §4.2: one response body is at most 64 KiB outside the stated exceptions. */
export const MAXIMUM_RESPONSE_BYTES = 65_536;

/** RFC 0004 §4.2: one request body is at most 16 KiB. */
export const MAXIMUM_REQUEST_BYTES = 16_384;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpsEndpoint {
  readonly url: string;
  readonly pathname: string;
}

/**
 * Every control-plane URL is an exact absolute HTTPS identifier with no user
 * information, query or fragment. A value that does not round-trip through
 * `URL` is rejected rather than normalized.
 *
 * One deviation from byte-for-byte equality is required rather than convenient.
 * RFC 0004 §3 states that `issuer` has no trailing slash, and its own example
 * issuer is the bare origin `https://control.example.test`. `URL` serializes
 * that back with a trailing slash, so demanding exact equality would reject
 * every origin-only issuer the RFC describes and force an arbitrary path
 * segment onto every deployment. An empty path is therefore accepted in either
 * spelling; nothing else is relaxed, so a stray query, a default port or a
 * non-normalized path is still refused.
 */
export function canonicalHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw contractError(`${label} is not a bounded URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw contractError(`${label} is not a URL`);
  }
  const roundTrips = parsed.href === value
    || (parsed.pathname === '/' && parsed.href === `${value}/`);
  if (parsed.protocol !== 'https:'
    || parsed.hostname === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !roundTrips) {
    throw contractError(`${label} is not a canonical HTTPS identifier`);
  }
  return value;
}

export function cancelBody(response: Response | undefined): void {
  try {
    const cancellation = response?.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // A hostile Fetch implementation cannot change the caller's outcome.
  }
}

export async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null
    && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)) {
    cancelBody(response);
    throw contractError('Response declared a body above the permitted ceiling');
  }
  if (response.body === null) throw contractError('Response carried no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw contractError('Response body exceeded the permitted ceiling');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== size) {
    throw contractError('Response body did not match its declared Content-Length');
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonBody(response: Response): Promise<JsonValue> {
  const body = await readBoundedBody(response, MAXIMUM_RESPONSE_BYTES);
  if (body.byteLength === 0) throw contractError('Response carried an empty JSON body');
  return parseJson(body);
}

export function requestBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_REQUEST_BYTES) {
    throw contractError('Request body exceeds the 16 KiB control-plane ceiling');
  }
  return body;
}

/**
 * A control-plane request never follows a redirect, never carries a cookie and
 * never negotiates compression for an exact identifier.
 */
export function jsonRequestInit(
  method: 'GET' | 'POST',
  token: string,
  body: string | undefined,
  signal: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  return {
    method,
    headers,
    redirect: 'error',
    signal,
    ...(body === undefined ? {} : { body }),
  };
}
