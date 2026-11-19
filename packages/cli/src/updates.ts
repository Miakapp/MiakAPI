/**
 * Knowing that a newer CLI exists, and what it changes.
 *
 * A home repository pins one CLI release (the pack writes it into `.mcp.json`),
 * so nothing moves under the owner's feet — and nothing tells the agent that a
 * release brought something worth having. This module closes that gap without
 * making any command depend on the network:
 *
 * - the latest version is asked of the npm registry at most once a day, the
 *   answer cached in the CLI's own directory, and any failure is silence;
 * - the changelog ships in the package (`assets/changelog.json`) and, for
 *   releases newer than the running one, is read from the latest package on a
 *   CDN. A version the CLI cannot describe is still listed, never invented.
 */
import { contractError, projectError } from './errors.js';
import type { FetchLike } from './internal/http.js';
import { PACKAGE_NAME } from './version.js';

export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2F')}/latest`;

export function changelogUrl(version: string): string {
  return `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${version}/assets/changelog.json`;
}

/** The cache lives beside contexts: `~/.miakapp/update-check.json`. */
export const UPDATE_CACHE_FILE = 'update-check.json';

/** Set to `0` to turn the automatic check off; `CI` turns it off too. */
export const UPDATE_CHECK_VARIABLE = 'MIAKAPP_UPDATE_CHECK';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 2_500;

export interface ChangelogEntry {
  readonly version: string;
  readonly date: string;
  /** What it brings the home, in words the owner understands. */
  readonly home: string;
  /** What the agent must change in the repository. */
  readonly steps: readonly string[];
}

// ---------------------------------------------------------------------------
// Versions

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

function parse(value: string): ParsedVersion {
  const match = VERSION.exec(value);
  if (match === null) throw new Error(`Not a version: ${value}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** Semver precedence: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index]! - right.core[index]!;
    if (delta !== 0) return delta;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return (left.pre.length === 0 ? 1 : 0) - (right.pre.length === 0 ? 1 : 0);
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta;
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Changelog

/** Parses `assets/changelog.json`. Malformed entries are refused, not skipped. */
export function parseChangelog(text: string, origin: string): ChangelogEntry[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw projectError(`${origin} is not valid JSON`);
  }
  const releases = (document as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases)) throw projectError(`${origin} has no releases list`);
  return releases.map((raw, index) => {
    const entry = raw as Record<string, unknown>;
    const { version, date, home, steps } = entry;
    if (typeof version !== 'string' || !isVersion(version)
      || typeof date !== 'string' || typeof home !== 'string'
      || !Array.isArray(steps) || !steps.every((step) => typeof step === 'string')) {
      throw projectError(`${origin}: release #${index + 1} is malformed`);
    }
    return { version, date, home, steps: steps as string[] };
  });
}

/** Merges two changelogs by version; `preferred` wins a duplicate. Newest first. */
export function mergeChangelogs(
  preferred: readonly ChangelogEntry[],
  other: readonly ChangelogEntry[],
): ChangelogEntry[] {
  const byVersion = new Map<string, ChangelogEntry>();
  for (const entry of other) byVersion.set(entry.version, entry);
  for (const entry of preferred) byVersion.set(entry.version, entry);
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** Entries strictly after `since`, up to and including `until`. Newest first. */
export function changesBetween(
  entries: readonly ChangelogEntry[],
  since: string,
  until: string,
): ChangelogEntry[] {
  return entries
    .filter((entry) => compareVersions(entry.version, since) > 0
      && compareVersions(entry.version, until) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

// ---------------------------------------------------------------------------
// Network

async function getJson(fetcher: FetchLike, url: string): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw contractError(`${url} answered ${response.status}`);
  const text = await response.text();
  if (text.length > 1_048_576) throw contractError(`${url} answered more than 1 MiB`);
  return JSON.parse(text) as unknown;
}

/** The registry's `latest` dist-tag. Throws on any failure; callers decide. */
export async function fetchLatestVersion(fetcher: FetchLike): Promise<string> {
  const body = await getJson(fetcher, REGISTRY_LATEST_URL);
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || !isVersion(version)) {
    throw contractError('The npm registry answered without a version');
  }
  return version;
}

/** The changelog of a published release, or `undefined` when unreachable. */
export async function fetchChangelog(
  fetcher: FetchLike,
  version: string,
): Promise<ChangelogEntry[] | undefined> {
  try {
    const body = await getJson(fetcher, changelogUrl(version));
    return parseChangelog(JSON.stringify(body), changelogUrl(version));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Daily check

export interface UpdateCache {
  readonly checkedAt: number;
  readonly latest: string | undefined;
  readonly notifiedAt: number | undefined;
}

export interface CacheStore {
  read(path: string): Promise<Uint8Array>;
  replace(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export function decodeCache(bytes: Uint8Array): UpdateCache | undefined {
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const checkedAt = Date.parse(String(raw['checked_at']));
    if (Number.isNaN(checkedAt)) return undefined;
    const latest = typeof raw['latest'] === 'string' && isVersion(raw['latest']) ? raw['latest'] : undefined;
    const notified = typeof raw['notified_at'] === 'string' ? Date.parse(raw['notified_at']) : Number.NaN;
    return { checkedAt, latest, notifiedAt: Number.isNaN(notified) ? undefined : notified };
  } catch {
    return undefined;
  }
}

function encodeCache(cache: UpdateCache): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    checked_at: new Date(cache.checkedAt).toISOString(),
    latest: cache.latest ?? null,
    notified_at: cache.notifiedAt === undefined ? null : new Date(cache.notifiedAt).toISOString(),
  }, null, 2)}\n`);
}

export interface UpdateCheckOptions {
  readonly directory: string;
  readonly files: CacheStore;
  readonly fetch: FetchLike;
  readonly now: number;
  readonly current: string;
}

export interface UpdateInfo {
  readonly current: string;
  readonly latest: string;
  /** True when this run is the first to report it in a day. */
  readonly fresh: boolean;
}

/**
 * Returns the newer version when one is known, refreshing the cache at most
 * once a day. Never throws: an update notice is never worth a failed command.
 *
 * Runs only when the CLI's directory already exists (the machine was paired):
 * the check creates nothing, so a test or a fresh CI runner stays untouched.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateInfo | undefined> {
  try {
    if (!await options.files.exists(options.directory)) return undefined;
    const path = `${options.directory}/${UPDATE_CACHE_FILE}`;
    let cache = await options.files.exists(path)
      ? decodeCache(await options.files.read(path))
      : undefined;

    if (cache === undefined || options.now - cache.checkedAt >= CHECK_INTERVAL_MS
      || options.now < cache.checkedAt) {
      let latest = cache?.latest;
      try {
        latest = await fetchLatestVersion(options.fetch);
      } catch {
        // Offline or the registry is down: keep what we knew, ask again tomorrow.
      }
      cache = { checkedAt: options.now, latest, notifiedAt: cache?.notifiedAt };
      await options.files.replace(path, encodeCache(cache));
    }

    const latest = cache.latest;
    if (latest === undefined || compareVersions(latest, options.current) <= 0) return undefined;
    const fresh = cache.notifiedAt === undefined || options.now - cache.notifiedAt >= CHECK_INTERVAL_MS;
    if (fresh) await options.files.replace(path, encodeCache({ ...cache, notifiedAt: options.now }));
    return { current: options.current, latest, fresh };
  } catch {
    return undefined;
  }
}

export function updateNotice(info: { current: string; latest: string }): string {
  return `Miakapp ${info.latest} is available (you have ${info.current}). `
    + 'Run `npx -y @miakapp/cli@latest changes` to see what it brings, '
    + 'then ask the owner before `npx -y @miakapp/cli@latest update`.';
}

export function updateJson(info: { current: string; latest: string }): Record<string, unknown> {
  return {
    current: info.current,
    latest: info.latest,
    next_step: 'npx -y @miakapp/cli@latest changes',
  };
}
