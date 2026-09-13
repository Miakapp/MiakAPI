/**
 * Identifier and name grammars shared by RFC 0001 §5.2, RFC 0002 §7.1 and
 * RFC 0004 §4.1. Every value is validated as an exact byte string: nothing here
 * case-folds, Unicode-normalizes or trims.
 */
const CONTROL_CHARACTER = /\p{Cc}/u;
const UTF8 = new TextEncoder();

const HOME_ID = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PRESENTATION_HANDLE = /^media\.[^.]/;

/** RFC 0002 §7.1 caps the artifact at 2 MiB decoded. */
export const MAXIMUM_ARTIFACT_BYTES = 2_097_152;

/** RFC 0002 §10 aborts tokenization beyond this program ceiling. */
export const MAXIMUM_PROGRAM_TOKENS = 100_000;

/**
 * RFC 0002 requires each requirement list to be "duplicate-free, bounded" but
 * states no per-list ceiling. This is the CLI-side bound derived from the
 * RFC 0004 §4.2 16 KiB request body and 2,048-value JSON limits.
 */
export const MAXIMUM_REQUIREMENTS_PER_LIST = 256;

export const REQUIREMENT_KINDS = [
  'state_read',
  'event_subscribe',
  'event_publish',
  'call',
  'presentation',
] as const;

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export type Requirements = {
  readonly [Kind in RequirementKind]: readonly string[];
};

export function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

export function isHomeId(value: unknown): value is string {
  return typeof value === 'string' && HOME_ID.test(value) && value.length <= 63;
}

/** 16 random bytes as unpadded base64url: upload IDs, Home Key IDs, JWS IDs. */
export function isRandomId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 22 && canonicalBase64Url(value, 16);
}

/** 32 random bytes as unpadded base64url: upload capability secrets and digests. */
export function isUploadToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && canonicalBase64Url(value, 32);
}

/** A SHA-256 digest encoded as unpadded base64url, per RFC 0002 §7.1. */
export function isDigest(value: unknown): value is string {
  return isUploadToken(value);
}

export function canonicalBase64Url(value: string, bytes: number): boolean {
  if (!BASE64URL.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === bytes && decoded.toString('base64url') === value;
}

/** RFC 0002 §7.1: non-empty UTF-8 of at most 64 bytes. */
export function isRelease(value: unknown): value is string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) return false;
  const bytes = utf8Bytes(value);
  return bytes >= 1 && bytes <= 64;
}

/** `generation` is a positive safe integer. */
export function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * RFC 0001 §5.2 dotted name: 1..256 UTF-8 bytes, no control characters, no `*`,
 * no leading or trailing dot, no empty dotted segment.
 */
export function isDottedName(value: unknown): value is string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value) || value.includes('*')) {
    return false;
  }
  const bytes = utf8Bytes(value);
  if (bytes < 1 || bytes > 256) return false;
  return value.split('.').every((segment) => segment.length > 0);
}

/**
 * A state, event or call requirement: an exact dotted name, or a dotted prefix
 * whose only `*` is the reserved trailing `.*` ACL suffix.
 */
export function isRequirementPattern(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.endsWith('.*')) return isDottedName(value);
  const prefix = value.slice(0, -2);
  return utf8Bytes(value) <= 256 && isDottedName(prefix);
}

/**
 * ABI 1 presentation requirements are exact `media.` handles. A wildcard grant
 * is forbidden so each host-owned surface stays explicitly enumerated.
 */
export function isPresentationHandle(value: unknown): value is string {
  return isDottedName(value) && typeof value === 'string' && PRESENTATION_HANDLE.test(value);
}

export function isValidRequirement(kind: RequirementKind, value: unknown): boolean {
  return kind === 'presentation' ? isPresentationHandle(value) : isRequirementPattern(value);
}
