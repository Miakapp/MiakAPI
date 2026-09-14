import {
  artifactError,
  authorizationError,
  conflictError,
  contractError,
  unknownOutcomeError,
  type CliError,
} from './errors.js';
import {
  MAXIMUM_RESPONSE_BYTES,
  cancelBody,
  jsonRequestInit,
  readBoundedBody,
  readJsonBody,
  requestBody,
  type FetchLike,
} from './internal/http.js';
import {
  boundedString,
  exactRecord,
  instant,
  parseJson,
  positiveInteger,
} from './internal/json.js';
import {
  MAXIMUM_ARTIFACT_BYTES,
  isDigest,
  isGeneration,
  isHomeId,
  isRandomId,
  isRelease,
  isUploadToken,
  REQUIREMENT_KINDS,
  type Requirements,
} from './internal/names.js';
import { canonicalRequirements, sameRequirements } from './internal/requirements.js';
import type { Artifact } from './artifact.js';

export const COMPONENT_ABI = 'miakapp.component/1';

/** RFC 0004 §13.2 expires an upload capability within fifteen minutes. */
const MAXIMUM_CAPABILITY_LIFETIME_MS = 900_000;

export type UploadStatus = 'awaiting_upload' | 'delivered' | 'finalized';

export interface UploadCapability {
  readonly uploadId: string;
  readonly uploadUrl: string;
  readonly uploadToken: string;
  readonly expiresAt: string;
}

export interface UploadState {
  readonly uploadId: string;
  readonly status: UploadStatus;
  readonly release: string;
  readonly abi: string;
  readonly sha256: string;
  readonly size: number;
  readonly requires: Requirements;
  readonly expiresAt: string;
}

export interface ComponentRelease {
  readonly release: string;
  readonly abi: string;
  readonly sha256: string;
  readonly size: number;
  readonly requires: Requirements;
  readonly finalizedAt: string;
}

export interface ComponentPointer {
  readonly homeId: string;
  readonly generation: number;
  readonly release: string;
  readonly abi: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly requires: Requirements;
}

export interface PublicationTarget {
  /** Control-plane issuer, without a trailing slash. */
  readonly issuer: string;
  readonly homeId: string;
  /** Five-minute `components:publish` access token. */
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

export interface UploadRequest {
  readonly release: string;
  readonly requires: Requirements;
}

interface ControlPlaneFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly message: string;
}

function client(target: PublicationTarget): {
  fetcher: FetchLike;
  signal: AbortSignal;
  base: string;
} {
  if (!isHomeId(target.homeId)) throw contractError('homeId is not a valid Miakapp home ID');
  const fetcher = target.fetch ?? globalThis.fetch;
  return {
    fetcher,
    signal: target.signal ?? new AbortController().signal,
    base: `${target.issuer}/v1/homes/${target.homeId}`,
  };
}

async function readFailure(response: Response): Promise<ControlPlaneFailure> {
  let parsed: unknown;
  try {
    parsed = parseJson(await readBoundedBody(response, MAXIMUM_RESPONSE_BYTES));
  } catch {
    return {
      code: 'unparseable',
      retryable: false,
      requestId: '',
      message: `HTTP ${response.status} with no closed error body`,
    };
  }
  const envelope = exactRecord(parsed, ['error']);
  const error = exactRecord(envelope.error, ['code', 'message', 'retryable', 'request_id']);
  if (typeof error.retryable !== 'boolean') {
    throw contractError('Error envelope has a non-boolean retryable field');
  }
  return {
    code: boundedString(error.code, 1, 64),
    retryable: error.retryable,
    requestId: boundedString(error.request_id, 0, 64),
    message: boundedString(error.message, 1, 1_024),
  };
}

/**
 * Maps the RFC 0004 §16 closed failure table onto CLI outcomes.
 *
 * `temporarily_unavailable` after a mutating request is deliberately
 * `unknown_outcome`: §17 states the effect may already have crossed its commit
 * boundary, so the caller reconciles with a read instead of repeating it.
 */
function failure(
  operation: string,
  status: number,
  error: ControlPlaneFailure,
  mutating: boolean,
): CliError {
  const detail = `${operation} failed with HTTP ${status} ${error.code}`
    + (error.requestId === '' ? '' : ` (request ${error.requestId})`);
  switch (error.code) {
    case 'invalid_home_key':
    case 'invalid_access_token':
    case 'insufficient_scope':
    case 'not_home_owner':
    case 'publisher_mismatch':
    case 'recent_authentication_required':
      return authorizationError(detail, error.message);
    case 'invalid_upload_capability':
      return authorizationError(
        detail,
        'The capability is absent, expired, replayed or bound to another tuple. '
        + 'Read the upload status before requesting a new one.',
      );
    case 'generation_conflict':
      return conflictError(
        detail,
        'Another publication advanced the pointer. Read the active generation and retry the '
        + 'activation with the observed expected_generation.',
      );
    case 'digest_quarantined':
      return artifactError(detail, 'A quarantined digest cannot be activated, even by the owner.');
    case 'invalid_artifact':
      return artifactError(detail, error.message);
    case 'limit_exceeded':
      return artifactError(detail, error.message);
    case 'temporarily_unavailable':
      return mutating
        ? unknownOutcomeError(
          detail,
          'The effect may already have committed. Reconcile with the upload-status or '
          + 'release read before acting again.',
        )
        : contractError(detail, error.message);
    default:
      return contractError(detail, error.message);
  }
}

function decodeRequirements(value: unknown): Requirements {
  const record = exactRecord(value, [...REQUIREMENT_KINDS]);
  return canonicalRequirements(record);
}

function decodeUploadCapability(value: unknown, uploadBase: string): UploadCapability {
  const document = exactRecord(value, [
    'schema',
    'upload_id',
    'upload_url',
    'upload_token',
    'expires_at',
  ]);
  if (document.schema !== 'miakapp.component-upload/1') {
    throw contractError('Upload response has an unsupported schema');
  }
  const uploadId = document.upload_id;
  if (!isRandomId(uploadId)) throw contractError('upload_id is not a 22-character random ID');
  if (!isUploadToken(document.upload_token)) {
    throw contractError('upload_token is not a 43-character capability secret');
  }
  const uploadUrl = boundedString(document.upload_url, 1, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    throw contractError('upload_url is not a URL');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.href !== uploadUrl
    || !uploadUrl.endsWith(`/${uploadId}`)
    || !uploadUrl.startsWith(uploadBase)) {
    throw contractError(
      'upload_url is not a credential-free HTTPS identifier for this home ending in its upload ID',
    );
  }
  const expiresAt = instant(document.expires_at);
  const lifetime = Date.parse(expiresAt) - Date.now();
  if (lifetime <= 0 || lifetime > MAXIMUM_CAPABILITY_LIFETIME_MS) {
    throw contractError('Upload capability is expired or exceeds the fifteen-minute ceiling');
  }
  return Object.freeze({
    uploadId,
    uploadUrl,
    uploadToken: document.upload_token,
    expiresAt,
  });
}

function decodeUploadState(value: unknown): UploadState {
  const document = exactRecord(value, [
    'schema',
    'upload_id',
    'status',
    'release',
    'abi',
    'sha256',
    'size',
    'requires',
    'expires_at',
  ]);
  if (document.schema !== 'miakapp.component-upload-status/1') {
    throw contractError('Upload-status response has an unsupported schema');
  }
  const status = document.status;
  if (status !== 'awaiting_upload' && status !== 'delivered' && status !== 'finalized') {
    throw contractError('Upload status is outside the closed set');
  }
  if (!isRandomId(document.upload_id)) throw contractError('upload_id is invalid');
  if (!isRelease(document.release)) throw contractError('release is invalid');
  if (!isDigest(document.sha256)) throw contractError('sha256 is not a base64url SHA-256 digest');
  if (document.abi !== COMPONENT_ABI) throw contractError('abi is not the supported ABI');
  return Object.freeze({
    uploadId: document.upload_id,
    status,
    release: document.release,
    abi: COMPONENT_ABI,
    sha256: document.sha256,
    size: positiveInteger(document.size, MAXIMUM_ARTIFACT_BYTES),
    requires: decodeRequirements(document.requires),
    expiresAt: instant(document.expires_at),
  });
}

function decodeRelease(value: unknown): ComponentRelease {
  const document = exactRecord(value, [
    'schema',
    'release',
    'abi',
    'sha256',
    'size',
    'requires',
    'finalized_at',
  ]);
  if (document.schema !== 'miakapp.component-release/1') {
    throw contractError('Release response has an unsupported schema');
  }
  if (!isRelease(document.release)) throw contractError('release is invalid');
  if (!isDigest(document.sha256)) throw contractError('sha256 is not a base64url SHA-256 digest');
  if (document.abi !== COMPONENT_ABI) throw contractError('abi is not the supported ABI');
  return Object.freeze({
    release: document.release,
    abi: COMPONENT_ABI,
    sha256: document.sha256,
    size: positiveInteger(document.size, MAXIMUM_ARTIFACT_BYTES),
    requires: decodeRequirements(document.requires),
    finalizedAt: instant(document.finalized_at),
  });
}

function decodePointer(value: unknown, target: PublicationTarget): ComponentPointer {
  const document = exactRecord(value, [
    'schema',
    'home_id',
    'generation',
    'release',
    'abi',
    'url',
    'sha256',
    'size',
    'requires',
  ]);
  if (document.schema !== 'miakapp.component-pointer/1') {
    throw contractError('Pointer response has an unsupported schema');
  }
  if (document.home_id !== target.homeId) {
    throw contractError('Pointer names a different home');
  }
  if (!isGeneration(document.generation)) {
    throw contractError('Pointer generation is not a positive safe integer');
  }
  if (!isRelease(document.release)) throw contractError('Pointer release is invalid');
  if (!isDigest(document.sha256)) throw contractError('Pointer sha256 is invalid');
  if (document.abi !== COMPONENT_ABI) throw contractError('Pointer abi is not the supported ABI');
  const url = boundedString(document.url, 1, 2_048);
  if (url !== `${target.issuer}/v1/components/${document.sha256}.js`) {
    throw contractError('Pointer url is not the token-free control-plane artifact resource');
  }
  return Object.freeze({
    homeId: target.homeId,
    generation: document.generation,
    release: document.release,
    abi: COMPONENT_ABI,
    url,
    sha256: document.sha256,
    size: positiveInteger(document.size, MAXIMUM_ARTIFACT_BYTES),
    requires: decodeRequirements(document.requires),
  });
}

/** Step 1: request one capability bound to the complete publication tuple. */
export async function requestUpload(
  target: PublicationTarget,
  artifact: Artifact,
  request: UploadRequest,
): Promise<UploadCapability> {
  const { fetcher, signal, base } = client(target);
  if (!isRelease(request.release)) {
    throw contractError('release must be 1..64 UTF-8 bytes without control characters');
  }
  const body = requestBody({
    release: request.release,
    abi: COMPONENT_ABI,
    sha256: artifact.sha256,
    size: artifact.size,
    requires: request.requires,
  });
  const response = await fetcher(
    `${base}/component-uploads`,
    jsonRequestInit('POST', target.token, body, signal),
  );
  if (response.status !== 201) {
    throw failure('Upload capability request', response.status, await readFailure(response), false);
  }
  return decodeUploadCapability(await readJsonBody(response), `${base}/component-uploads/`);
}

/**
 * Step 2: deliver the exact bytes once.
 *
 * A lost response is never retried with a new capability: the caller reconciles
 * through {@link readUpload}, which distinguishes `awaiting_upload` from
 * `delivered`.
 */
export async function deliverArtifact(
  target: PublicationTarget,
  capability: UploadCapability,
  artifact: Artifact,
): Promise<void> {
  const { fetcher, signal } = client(target);
  let response: Response;
  try {
    response = await fetcher(capability.uploadUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${capability.uploadToken}`,
        'content-type': 'application/javascript; charset=utf-8',
        'content-length': String(artifact.size),
      },
      body: artifact.bytes,
      redirect: 'error',
      credentials: 'omit',
      signal,
    });
  } catch {
    throw unknownOutcomeError(
      'Artifact delivery did not return a response',
      'Read the upload status before deciding whether to deliver again.',
    );
  }
  if (response.status === 204) {
    cancelBody(response);
    return;
  }
  throw failure('Artifact delivery', response.status, await readFailure(response), true);
}

/** Step 3: finalize only the delivered, content-addressed object. */
export async function finalizeUpload(
  target: PublicationTarget,
  uploadId: string,
): Promise<ComponentRelease> {
  const { fetcher, signal, base } = client(target);
  if (!isRandomId(uploadId)) throw contractError('uploadId is not a 22-character random ID');
  const response = await fetcher(
    `${base}/component-uploads/${uploadId}:finalize`,
    jsonRequestInit('POST', target.token, requestBody({}), signal),
  );
  if (response.status !== 200) {
    throw failure('Finalization', response.status, await readFailure(response), true);
  }
  return decodeRelease(await readJsonBody(response));
}

/** Reconciliation read that tells a lost `PUT` from an undelivered upload. */
export async function readUpload(
  target: PublicationTarget,
  uploadId: string,
): Promise<UploadState> {
  const { fetcher, signal, base } = client(target);
  if (!isRandomId(uploadId)) throw contractError('uploadId is not a 22-character random ID');
  const response = await fetcher(
    `${base}/component-uploads/${uploadId}`,
    jsonRequestInit('GET', target.token, undefined, signal),
  );
  if (response.status !== 200) {
    throw failure('Upload-status read', response.status, await readFailure(response), false);
  }
  return decodeUploadState(await readJsonBody(response));
}

/** Reconciliation read for a lost finalization response. */
export async function readRelease(
  target: PublicationTarget,
  sha256: string,
): Promise<ComponentRelease | undefined> {
  const { fetcher, signal, base } = client(target);
  if (!isDigest(sha256)) throw contractError('sha256 is not a base64url SHA-256 digest');
  const response = await fetcher(
    `${base}/component-releases/${sha256}`,
    jsonRequestInit('GET', target.token, undefined, signal),
  );
  if (response.status === 422) {
    const error = await readFailure(response);
    if (error.code === 'invalid_artifact') return undefined;
    throw failure('Release read', response.status, error, false);
  }
  if (response.status !== 200) {
    throw failure('Release read', response.status, await readFailure(response), false);
  }
  return decodeRelease(await readJsonBody(response));
}

/**
 * Step 4: compare-and-set the home pointer to a strictly greater generation.
 *
 * Activation is one transaction and is never blindly retried: a stale
 * `expected_generation` fails with `generation_conflict` rather than
 * last-write-wins.
 */
export async function activateRelease(
  target: PublicationTarget,
  activation: {
    readonly sha256: string;
    readonly expectedGeneration: number;
    readonly generation: number;
  },
): Promise<ComponentPointer> {
  const { fetcher, signal, base } = client(target);
  if (!isDigest(activation.sha256)) {
    throw contractError('sha256 is not a base64url SHA-256 digest');
  }
  if (!Number.isSafeInteger(activation.expectedGeneration) || activation.expectedGeneration < 0) {
    throw contractError('expected_generation must be a non-negative safe integer');
  }
  if (!isGeneration(activation.generation)
    || activation.generation <= activation.expectedGeneration) {
    throw contractError('generation must be a positive safe integer above expected_generation');
  }
  const body = requestBody({
    sha256: activation.sha256,
    expected_generation: activation.expectedGeneration,
    generation: activation.generation,
  });
  const response = await fetcher(
    `${base}/component-releases:activate`,
    jsonRequestInit('POST', target.token, body, signal),
  );
  if (response.status !== 200) {
    throw failure('Activation', response.status, await readFailure(response), true);
  }
  return decodePointer(await readJsonBody(response), target);
}

/**
 * Publishes one artifact: capability, delivery, finalization, activation.
 *
 * Every step is checked against the locally computed digest, size and
 * requirements, so a control plane that echoes different metadata is rejected
 * rather than trusted.
 */
export async function publish(
  target: PublicationTarget,
  artifact: Artifact,
  request: UploadRequest & {
    readonly expectedGeneration: number;
    readonly generation: number;
  },
): Promise<{ readonly release: ComponentRelease; readonly pointer: ComponentPointer }> {
  const requires = canonicalRequirements(request.requires);
  const capability = await requestUpload(target, artifact, { release: request.release, requires });
  await deliverArtifact(target, capability, artifact);
  const state = await readUpload(target, capability.uploadId);
  if (state.sha256 !== artifact.sha256
    || state.size !== artifact.size
    || state.release !== request.release
    || !sameRequirements(state.requires, requires)) {
    throw contractError('Upload state does not match the tuple the capability was bound to');
  }
  if (state.status === 'awaiting_upload') {
    throw unknownOutcomeError(
      'The control plane still reports the upload as awaiting delivery',
      'Request a new capability and deliver the bytes again; do not finalize this upload.',
    );
  }
  const release = state.status === 'finalized'
    ? await requireRelease(target, artifact.sha256)
    : await finalizeUpload(target, capability.uploadId);
  if (release.sha256 !== artifact.sha256 || release.size !== artifact.size) {
    throw contractError('Finalized release does not match the delivered artifact');
  }
  const pointer = await activateRelease(target, {
    sha256: artifact.sha256,
    expectedGeneration: request.expectedGeneration,
    generation: request.generation,
  });
  if (pointer.sha256 !== artifact.sha256 || !sameRequirements(pointer.requires, requires)) {
    throw contractError('Activated pointer does not match the published release');
  }
  return { release, pointer };
}

async function requireRelease(
  target: PublicationTarget,
  sha256: string,
): Promise<ComponentRelease> {
  const release = await readRelease(target, sha256);
  if (release === undefined) {
    throw unknownOutcomeError(
      'The upload reports finalized but no release record is readable',
      'Re-read the release before publishing again; the control plane is mid-commit or '
      + 'has quarantined the digest.',
    );
  }
  return release;
}
