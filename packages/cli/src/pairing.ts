/**
 * Redeems a one-time pairing code for a new Home Key.
 *
 * The person picks the home and confirms access in their own browser, on the
 * pairing page of their own account; the agent never signs in anywhere. What
 * reaches the agent is a short-lived, single-use code, and this module trades
 * it for a fresh, separately revocable key — one key per agent or machine,
 * never a copy of someone else's.
 *
 * Contract (shared with the control plane, fixed):
 *
 *     POST {issuer}/v1/pairing/redeem
 *     {"code": "...", "label": "..."}
 *     → 200 {"home_key", "home_id", "key_id", "issuer"}, Cache-Control: no-store
 *
 * The request goes only to the issuer chosen before the code was read, after
 * that issuer's own discovery document confirmed it is a Miakapp control plane
 * under exactly that name. Redirects are refused, so a code cannot be walked to
 * another host, and the response must name the same issuer and a key whose ID
 * is embedded in the key itself.
 */
import { CliError, authorizationError, contractError, unknownOutcomeError, usageError } from './errors.js';
import {
  cancelBody,
  canonicalHttpsUrl,
  readBoundedBody,
  requestBody,
  type FetchLike,
} from './internal/http.js';
import { boundedString, exactRecord, parseJson } from './internal/json.js';
import { isHomeId } from './internal/names.js';

export const PAIRING_PATH = '/v1/pairing/redeem';
export const DEFAULT_ISSUER = 'https://control.miakapp.com';
export const PAIRING_PAGE = 'https://miakapp.com/pair';

const HOME_KEY = /^mhk1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const CODE = /^[\x21-\x7e]{4,128}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MAXIMUM_REDEEM_RESPONSE_BYTES = 16_384;

export interface PairingResult {
  readonly homeKey: string;
  readonly homeId: string;
  readonly keyId: string;
  readonly issuer: string;
}

/** Validates the issuer a code may be sent to, before the code is read. */
export function pairingIssuer(value: string): string {
  let issuer: string;
  try {
    issuer = canonicalHttpsUrl(value, 'issuer');
  } catch {
    throw usageError(
      `--issuer must be an exact https URL without a path suffix, query or fragment, received ${JSON.stringify(value)}`,
      `Omit --issuer to use ${DEFAULT_ISSUER}.`,
    );
  }
  if (issuer.endsWith('/')) throw usageError('--issuer must not have a trailing slash');
  return issuer;
}

/** Trims the surrounding whitespace a paste or a pipe adds, and nothing else. */
export function normalizeCode(value: string): string {
  const code = value.trim();
  if (code === '') {
    throw usageError(
      'No pairing code was provided',
      `Ask the owner to open ${PAIRING_PAGE}, confirm access to the home and send you the code.`,
    );
  }
  if (!CODE.test(code)) {
    throw usageError(
      'The pairing code must be 4..128 printable characters without spaces',
      'Paste the code exactly as the pairing page shows it.',
    );
  }
  return code;
}

export function validateLabel(value: string): string {
  if (value.length === 0
    || new TextEncoder().encode(value).byteLength > 64
    || CONTROL_CHARACTER.test(value)) {
    throw usageError('--label must be 1..64 UTF-8 bytes without control characters');
  }
  return value;
}

function orphanRemedy(label: string): string {
  return `The code may have been consumed. Ask the owner for a new code at ${PAIRING_PAGE}, and to `
    + `revoke any Home Key labelled ${JSON.stringify(label)} that they did not expect.`;
}

async function failureCode(response: Response): Promise<string | undefined> {
  try {
    const body = parseJson(await readBoundedBody(response, MAXIMUM_REDEEM_RESPONSE_BYTES));
    const error = (body as { error?: { code?: unknown } } | null)?.error;
    return typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sends the code once. Never retried: a lost response may hide a key that was
 * already issued, and the second attempt would only burn the attempt budget on
 * a code that is now spent.
 */
export async function redeemPairingCode(options: {
  readonly issuer: string;
  readonly code: string;
  readonly label: string;
  readonly fetch?: FetchLike;
}): Promise<PairingResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(`${options.issuer}${PAIRING_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
      },
      body: requestBody({ code: options.code, label: options.label }),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw unknownOutcomeError('The pairing request did not return a response', orphanRemedy(options.label));
  }

  if (response.status !== 200 && response.status !== 201) {
    const code = await failureCode(response);
    const suffix = code === undefined ? '' : ` ${code}`;
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      throw authorizationError(
        `The pairing service refused the attempt with HTTP 429${suffix}: too many attempts`,
        `${retry === null ? 'Wait' : `Wait ${retry} seconds`} before trying again, and check the code `
        + 'with the owner instead of guessing.',
      );
    }
    if (response.status >= 500) {
      throw unknownOutcomeError(
        `The pairing service failed with HTTP ${response.status}${suffix}`,
        orphanRemedy(options.label),
      );
    }
    throw authorizationError(
      `The pairing code was refused with HTTP ${response.status}${suffix}`,
      'A code works once and for ten minutes. Ask the owner to create a new one at '
      + `${PAIRING_PAGE} and send it to you.`,
    );
  }

  const cacheControl = (response.headers.get('cache-control') ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase());
  if (!cacheControl.includes('no-store')) {
    cancelBody(response);
    throw contractError(
      'The pairing response is missing Cache-Control: no-store; the key it carries was discarded',
      `Report the control plane. Ask the owner to revoke the Home Key labelled ${JSON.stringify(options.label)}.`,
    );
  }

  let result: PairingResult;
  try {
    // The contract fixes these four fields. A `schema` tag is tolerated because
    // every other control-plane document carries one; any other member is a
    // contract change and is refused. Nothing but the four is ever stored.
    const document = exactRecord(
      parseJson(await readBoundedBody(response, MAXIMUM_REDEEM_RESPONSE_BYTES)),
      ['home_key', 'home_id', 'key_id', 'issuer'],
      ['schema'],
    );
    const homeKey = boundedString(document.home_key, 1, 256);
    const keyId = boundedString(document.key_id, 22, 22);
    const match = HOME_KEY.exec(homeKey);
    if (match?.[1] !== keyId) throw contractError('home_key does not carry key_id');
    if (!isHomeId(document.home_id)) throw contractError('home_id is not a Miakapp home ID');
    if (document.issuer !== options.issuer) {
      throw contractError(`The response names issuer ${String(document.issuer)}, not ${options.issuer}`);
    }
    result = Object.freeze({ homeKey, homeId: document.home_id, keyId, issuer: options.issuer });
  } catch (error) {
    const detail = error instanceof CliError ? `: ${error.message}` : '';
    throw contractError(
      `The pairing response does not match the redeem contract${detail}; nothing was stored`,
      `Report the control plane. Ask the owner to revoke the Home Key labelled ${JSON.stringify(options.label)}.`,
    );
  }
  return result;
}
