/**
 * Persistent, multi-home CLI contexts in `~/.miakapp`.
 *
 * A context names one Home Key for one home at one issuer, so an agent or a
 * machine that works on several homes never re-exports a secret and never
 * guesses which secret belongs to which house. Two files, split by sensitivity:
 *
 * - `config.json` holds what is safe to show: the context names, their issuer,
 *   home ID, key ID, key label and the current context. Printing it leaks
 *   nothing.
 * - `credentials.json` holds the Home Keys and nothing else.
 *
 * Both are written mode 0600 inside a 0700 directory, through a temporary file,
 * an fsync and a rename, so a crash leaves either the old file or the new one
 * and never half of each. A lock file serializes writers: two `miakapp pair`
 * runs finishing at the same moment must both keep their context, because the
 * code each one redeemed cannot be redeemed again.
 *
 * Reads refuse a credentials file that another account could read or replace,
 * the way `ssh` refuses a private key with loose permissions: silently using a
 * leaked key is worse than stopping.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { authorizationError, usageError } from './errors.js';
import { canonicalHttpsUrl } from './internal/http.js';
import { InvalidJsonError, boundedString, exactRecord, parseJson } from './internal/json.js';
import { isHomeId, isRandomId } from './internal/names.js';

export const CONFIG_DIRECTORY_VARIABLE = 'MIAKAPP_CONFIG_DIR';
export const CONFIG_FILE = 'config.json';
export const CREDENTIALS_FILE = 'credentials.json';
export const CONFIG_SCHEMA = 'miakapp.cli-config/1';
export const CREDENTIALS_SCHEMA = 'miakapp.cli-credentials/1';

const LOCK_FILE = 'lock';
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const MAXIMUM_FILE_BYTES = 262_144;
const MAXIMUM_CONTEXTS = 256;
const CONTEXT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HOME_KEY = /^mhk1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

export interface StoredContext {
  readonly name: string;
  readonly issuer: string;
  readonly homeId: string;
  readonly keyId: string;
  readonly label: string;
  readonly createdAt: string;
}

export interface ContextState {
  readonly current: string | null;
  readonly contexts: ReadonlyMap<string, StoredContext>;
}

/** Whether a context's Home Key is present and is the key it was paired with. */
export type CredentialStatus = 'stored' | 'missing' | 'mismatched';

interface Snapshot extends ContextState {
  readonly keys: ReadonlyMap<string, string>;
}

export function isContextName(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_NAME.test(value);
}

export function contextNameError(name: string): never {
  throw usageError(
    `Invalid context name ${JSON.stringify(name)}`,
    'A context name is 1..63 characters of a-z, 0-9, ".", "_" and "-", starting with a letter or digit.',
  );
}

/**
 * The directory holding both files. `MIAKAPP_CONFIG_DIR` relocates it for CI,
 * containers and tests; it must be absolute so a relative value can never
 * resolve to a different directory from one working directory to the next.
 */
export function configDirectory(env: (name: string) => string | undefined, home: string): string {
  const override = env(CONFIG_DIRECTORY_VARIABLE);
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw usageError(`${CONFIG_DIRECTORY_VARIABLE} must be an absolute path`);
    }
    return override;
  }
  return join(home, '.miakapp');
}

function enforcesModes(): boolean {
  return process.platform !== 'win32';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function storeError(path: string, problem: string): never {
  throw authorizationError(
    `${path} ${problem}`,
    'Repair or remove the file, then pair again with miakapp pair. The CLI never guesses at a '
    + 'credential store it cannot read exactly.',
  );
}

async function readStoreFile(path: string, secret: boolean): Promise<Uint8Array | undefined> {
  const fs = await import('node:fs/promises');
  let status;
  try {
    status = await fs.lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!status.isFile()) storeError(path, 'is not a regular file (symbolic links are refused)');
  if (status.size > MAXIMUM_FILE_BYTES) storeError(path, 'is larger than any context store');
  if (enforcesModes()) {
    const uid = process.getuid?.();
    if (uid !== undefined && status.uid !== uid) storeError(path, 'is owned by another account');
    // The credentials must be private. The configuration holds no secret, but
    // anyone able to rewrite it could repoint a context at their own issuer.
    const forbidden = secret ? 0o077 : 0o022;
    if ((status.mode & forbidden) !== 0) {
      throw authorizationError(
        `${path} is accessible to other accounts (mode ${(status.mode & 0o777).toString(8)})`,
        `Run chmod 600 ${path}. Rotate the Home Keys it holds if anyone else could have read it.`,
      );
    }
  }
  return new Uint8Array(await fs.readFile(path));
}

function decodeDocument(path: string, bytes: Uint8Array): Readonly<Record<string, unknown>> {
  try {
    const value = parseJson(bytes);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return storeError(path, 'is not a JSON object');
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof InvalidJsonError) return storeError(path, 'is not valid JSON');
    throw error;
  }
}

function decodeContext(path: string, name: string, value: unknown): StoredContext {
  try {
    const entry = exactRecord(value, ['issuer', 'home_id', 'key_id', 'label', 'created_at']);
    const issuer = canonicalHttpsUrl(entry.issuer, 'issuer');
    if (issuer.endsWith('/') || !isHomeId(entry.home_id) || !isRandomId(entry.key_id)) {
      throw new InvalidJsonError();
    }
    return Object.freeze({
      name,
      issuer,
      homeId: entry.home_id,
      keyId: entry.key_id,
      label: boundedString(entry.label, 1, 64),
      createdAt: boundedString(entry.created_at, 1, 64),
    });
  } catch {
    return storeError(path, `holds an invalid context ${JSON.stringify(name)}`);
  }
}

async function readSnapshot(directory: string): Promise<Snapshot> {
  const configPath = join(directory, CONFIG_FILE);
  const credentialsPath = join(directory, CREDENTIALS_FILE);
  const contexts = new Map<string, StoredContext>();
  const keys = new Map<string, string>();
  let current: string | null = null;

  const configBytes = await readStoreFile(configPath, false);
  if (configBytes !== undefined) {
    const document = decodeDocument(configPath, configBytes);
    if (document.schema !== CONFIG_SCHEMA) storeError(configPath, `does not declare ${CONFIG_SCHEMA}`);
    let entries: Readonly<Record<string, unknown>>;
    try {
      exactRecord(document, ['schema', 'current_context', 'contexts']);
      entries = exactRecord(document.contexts, [], Object.keys(document.contexts ?? {}));
    } catch {
      return storeError(configPath, 'does not match the closed configuration schema');
    }
    const names = Object.keys(entries);
    if (names.length > MAXIMUM_CONTEXTS) storeError(configPath, 'holds too many contexts');
    for (const name of names) {
      if (!isContextName(name)) storeError(configPath, `holds an invalid context name ${JSON.stringify(name)}`);
      contexts.set(name, decodeContext(configPath, name, entries[name]));
    }
    const selected = document.current_context;
    if (selected !== null && (typeof selected !== 'string' || !contexts.has(selected))) {
      storeError(configPath, 'names a current context it does not define');
    }
    current = selected as string | null;
  }

  const credentialBytes = await readStoreFile(credentialsPath, true);
  if (credentialBytes !== undefined) {
    const document = decodeDocument(credentialsPath, credentialBytes);
    if (document.schema !== CREDENTIALS_SCHEMA) {
      storeError(credentialsPath, `does not declare ${CREDENTIALS_SCHEMA}`);
    }
    let entries: Readonly<Record<string, unknown>>;
    try {
      exactRecord(document, ['schema', 'credentials']);
      entries = exactRecord(document.credentials, [], Object.keys(document.credentials ?? {}));
    } catch {
      return storeError(credentialsPath, 'does not match the closed credentials schema');
    }
    for (const [name, value] of Object.entries(entries)) {
      let key: unknown;
      try {
        key = exactRecord(value, ['home_key']).home_key;
      } catch {
        key = undefined;
      }
      if (typeof key !== 'string' || !HOME_KEY.test(key)) {
        storeError(credentialsPath, `holds an invalid credential for ${JSON.stringify(name)}`);
      }
      keys.set(name, key);
    }
  }
  return { current, contexts, keys };
}

function credentialStatus(snapshot: Snapshot, context: StoredContext): CredentialStatus {
  const key = snapshot.keys.get(context.name);
  if (key === undefined) return 'missing';
  return HOME_KEY.exec(key)?.[1] === context.keyId ? 'stored' : 'mismatched';
}

/**
 * Reads the safe half of the store, plus whether each key is present. A
 * missing directory is an empty store. No Home Key leaves this function.
 */
export async function readContexts(
  directory: string,
): Promise<ContextState & { readonly credentials: ReadonlyMap<string, CredentialStatus> }> {
  const snapshot = await readSnapshot(directory);
  const credentials = new Map<string, CredentialStatus>();
  for (const context of snapshot.contexts.values()) {
    credentials.set(context.name, credentialStatus(snapshot, context));
  }
  return { current: snapshot.current, contexts: snapshot.contexts, credentials };
}

/**
 * Returns one context and its Home Key, or fails with a remedy.
 *
 * The key ID recorded at pairing time is compared with the stored key, so a
 * credentials file edited by hand cannot silently attach another home's key to
 * this context.
 */
export async function readCredential(
  directory: string,
  name: string,
): Promise<{ readonly context: StoredContext; readonly homeKey: string }> {
  const snapshot = await readSnapshot(directory);
  const context = snapshot.contexts.get(name);
  if (context === undefined) {
    const known = [...snapshot.contexts.keys()];
    throw usageError(
      `No context named ${name}`,
      known.length === 0
        ? 'No context is configured yet. Run miakapp pair to add one.'
        : `Known contexts: ${known.join(', ')}. Run miakapp context list for details.`,
    );
  }
  const homeKey = snapshot.keys.get(name);
  const status = credentialStatus(snapshot, context);
  if (homeKey === undefined || status === 'missing') {
    throw authorizationError(
      `Context ${name} has no stored credential`,
      `Remove it with miakapp context remove ${name} and pair the home again.`,
    );
  }
  if (status === 'mismatched') {
    throw authorizationError(
      `The credential stored for ${name} is not the key ${context.keyId} it was paired with`,
      `Remove the context with miakapp context remove ${name} and pair the home again.`,
    );
  }
  return { context, homeKey };
}

async function syncDirectory(directory: string): Promise<void> {
  const fs = await import('node:fs/promises');
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Not every platform can fsync a directory; the rename is still atomic.
  } finally {
    await handle?.close();
  }
}

/**
 * Replaces one file atomically with a private one. The temporary name is
 * random and opened exclusively, so a stale temporary from a crashed run can
 * neither be reused nor followed.
 */
async function writeAtomic(directory: string, name: string, document: unknown): Promise<void> {
  const fs = await import('node:fs/promises');
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`);
    if (enforcesModes()) await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

async function ensureDirectory(directory: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await fs.lstat(directory);
  if (!status.isDirectory()) {
    throw authorizationError(`${directory} is not a directory`, 'Move it aside and run the command again.');
  }
  if (enforcesModes()) {
    const uid = process.getuid?.();
    if (uid !== undefined && status.uid !== uid) {
      throw authorizationError(`${directory} is owned by another account`, 'Use a directory you own.');
    }
    if ((status.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
  }
}

async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const fs = await import('node:fs/promises');
  const path = join(directory, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await fs.open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        await fs.rm(path, { force: true });
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    try {
      const status = await fs.stat(path);
      if (Date.now() - status.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(path, { force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() > deadline) {
      throw authorizationError(
        `Another miakapp process holds ${path}`,
        'Wait for it to finish. If none is running, delete the lock file.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface Mutation {
  current: string | null;
  readonly contexts: Map<string, StoredContext>;
  readonly keys: Map<string, string>;
}

/**
 * Applies one change under the lock and writes both files.
 *
 * The credentials are written before the configuration, so a crash between the
 * two leaves an unreferenced key rather than a context with no key. The next
 * write drops any credential no context references.
 */
export async function mutateContexts<T>(
  directory: string,
  change: (state: Mutation) => T,
): Promise<T> {
  await ensureDirectory(directory);
  const release = await acquireLock(directory);
  try {
    const snapshot = await readSnapshot(directory);
    const state: Mutation = {
      current: snapshot.current,
      contexts: new Map(snapshot.contexts),
      keys: new Map(snapshot.keys),
    };
    const result = change(state);
    if (state.contexts.size > MAXIMUM_CONTEXTS) {
      throw usageError(`At most ${MAXIMUM_CONTEXTS} contexts can be stored`);
    }
    if (state.current !== null && !state.contexts.has(state.current)) state.current = null;

    const credentials: Record<string, { home_key: string }> = {};
    const contexts: Record<string, unknown> = {};
    for (const [name, context] of [...state.contexts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = state.keys.get(name);
      if (key !== undefined) credentials[name] = { home_key: key };
      contexts[name] = {
        issuer: context.issuer,
        home_id: context.homeId,
        key_id: context.keyId,
        label: context.label,
        created_at: context.createdAt,
      };
    }
    await writeAtomic(directory, CREDENTIALS_FILE, { schema: CREDENTIALS_SCHEMA, credentials });
    await writeAtomic(directory, CONFIG_FILE, {
      schema: CONFIG_SCHEMA,
      current_context: state.current,
      contexts,
    });
    return result;
  } finally {
    await release();
  }
}
