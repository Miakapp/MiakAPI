import type {
  AccessTokenProvider,
  AccessToken,
  CallTarget,
  CoordinatorConfiguration,
  CoordinatorOptions,
  CoordinatorLogger,
  EventDeclaration,
  EventTarget,
  FunctionHandler,
  ProtocolObject,
  ProtocolValue,
  StartCallOptions,
  StateMutation,
  UserEventAccess,
  UserStateAccess,
} from '../api.js';
import type {
  BrowserCallOptions,
  BrowserClientLogger,
  BrowserClientOptions,
  FirebaseIdTokenProvider,
} from '../browser-api.js';
import { LIMITS } from '../protocol/codec.js';

const UTF8 = new TextEncoder();
const CONTROL_CHARACTER = /\p{Cc}/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const COORDINATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOME_ID = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

interface ValueBudget {
  values: number;
  bytes: number;
}

function accountValueBytes(budget: ValueBudget, bytes: number, label: string): void {
  budget.bytes += bytes;
  if (budget.bytes > LIMITS.frameBytes) {
    throw new RangeError(`${label} exceeds the aggregate value byte limit`);
  }
}

function accountDeclarationValue(
  budget: ValueBudget,
  valueBytes: number,
  label: string,
): void {
  budget.values += 1;
  if (budget.values > LIMITS.values) {
    throw new RangeError(`${label} exceeds the aggregate value count limit`);
  }
  accountValueBytes(budget, valueBytes + 1, label);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
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

function boundedString(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
  allowControlCharacters = false,
): string {
  if (typeof value !== 'string'
    || hasUnpairedSurrogate(value)
    || (!allowControlCharacters && CONTROL_CHARACTER.test(value))) {
    throw new TypeError(`${label} must be a safe UTF-8 string`);
  }
  const bytes = UTF8.encode(value).byteLength;
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new RangeError(`${label} must contain ${minimumBytes} to ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

export function validateCoordinatorName(value: unknown, label = 'coordinator name'): string {
  const name = boundedString(value, 1, 64, label);
  if (!COORDINATOR_NAME.test(name)) throw new TypeError(`${label} is invalid`);
  return name;
}

export function validateStructuredName(value: unknown, label: string): string {
  const name = boundedString(value, 1, 256, label);
  if (name.includes('*') || name.startsWith('.') || name.endsWith('.') || name.includes('..')) {
    throw new TypeError(`${label} must be a dotted name without empty segments`);
  }
  return name;
}

export function validatePattern(value: unknown, label: string): string {
  const pattern = boundedString(value, 1, 256, label);
  validateStructuredName(pattern.endsWith('.*') ? pattern.slice(0, -2) : pattern, label);
  return pattern;
}

function cloneProtocolValue(
  value: unknown,
  label: string,
  depth: number,
  budget: ValueBudget,
  ancestors: Set<object>,
): ProtocolValue {
  if (depth > LIMITS.depth) throw new RangeError(`${label} exceeds the value depth limit`);
  budget.values += 1;
  if (budget.values > LIMITS.values) throw new RangeError(`${label} exceeds the value count limit`);
  accountValueBytes(budget, 1, label);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(`${label} contains an invalid number`);
    }
    accountValueBytes(budget, 8, label);
    return value;
  }
  if (typeof value === 'string') {
    const result = boundedString(value, 0, LIMITS.stringBytes, label, true);
    accountValueBytes(budget, UTF8.encode(result).byteLength, label);
    return result;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > LIMITS.binaryBytes) {
      throw new RangeError(`${label} exceeds the binary value limit`);
    }
    accountValueBytes(budget, value.byteLength, label);
    return value.slice();
  }
  if (typeof value !== 'object') throw new TypeError(`${label} is not a protocol value`);
  if (ancestors.has(value)) throw new TypeError(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > LIMITS.arrayItems) throw new RangeError(`${label} exceeds the array limit`);
      accountValueBytes(budget, 4, label);
      const output: ProtocolValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`${label} contains a sparse array`);
        output.push(cloneProtocolValue(
          value[index],
          `${label}[${index}]`,
          depth + 1,
          budget,
          ancestors,
        ));
      }
      Object.freeze(output);
      return output;
    }
    if (!isPlainRecord(value)) throw new TypeError(`${label} contains a non-plain object`);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new TypeError(`${label} contains symbolic or non-enumerable keys`);
    }
    if (keys.length > LIMITS.mapEntries) throw new RangeError(`${label} exceeds the map limit`);
    accountValueBytes(budget, 4, label);
    const output: ProtocolObject = {};
    for (const key of keys) {
      boundedString(key, 0, LIMITS.mapKeyBytes, `${label} key`, true);
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`${label} contains a reserved key`);
      accountValueBytes(budget, UTF8.encode(key).byteLength + 1, label);
      output[key] = cloneProtocolValue(value[key], `${label}.${key}`, depth + 1, budget, ancestors);
    }
    Object.freeze(output);
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function validateProtocolValue(value: unknown, label = 'value'): ProtocolValue {
  return cloneProtocolValue(value, label, 1, { values: 0, bytes: 0 }, new Set());
}

function uniqueStrings(
  values: unknown,
  validator: (value: unknown, label: string) => string,
  label: string,
  budget?: ValueBudget,
): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  if (values.length > LIMITS.declarationsPerCoordinator) {
    throw new RangeError(`${label} exceeds the declaration limit`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const entry = validator(values[index], `${label}[${index}]`);
    if (seen.has(entry)) throw new TypeError(`${label} contains a duplicate`);
    if (budget !== undefined) {
      accountDeclarationValue(budget, UTF8.encode(entry).byteLength, label);
    }
    seen.add(entry);
    output.push(entry);
  }
  return Object.freeze(output);
}

function validateOpaqueId(value: unknown, label: string): string {
  return boundedString(value, 1, 128, label);
}

export function validateStateEntries(value: unknown): Readonly<Record<string, ProtocolValue>> {
  if (!isPlainRecord(value)) throw new TypeError('state declaration must be an object');
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError('state declaration contains invalid keys');
  }
  if (keys.length > LIMITS.statePathsPerCoordinator) {
    throw new RangeError('state declaration exceeds the path limit');
  }
  const output: Record<string, ProtocolValue> = Object.create(null);
  const budget: ValueBudget = { values: 0, bytes: 0 };
  for (const path of keys) {
    validateStructuredName(path, `state path ${path}`);
    accountValueBytes(budget, UTF8.encode(path).byteLength + 5, 'state declaration');
    output[path] = cloneProtocolValue(value[path], `state.${path}`, 1, budget, new Set());
  }
  return Object.freeze(output);
}

export function validateStateMutations(value: unknown): readonly StateMutation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.statePathsPerCoordinator) {
    throw new TypeError('state mutations must be a non-empty bounded array');
  }
  const paths = new Set<string>();
  const output: StateMutation[] = [];
  const budget: ValueBudget = { values: 0, bytes: 0 };
  for (let index = 0; index < value.length; index += 1) {
    const entry = exactObject(value[index], ['path'], ['value', 'delete'], `mutation[${index}]`);
    const path = validateStructuredName(entry.path, `mutation[${index}].path`);
    if (paths.has(path)) throw new TypeError('state mutations contain a duplicate path');
    paths.add(path);
    accountValueBytes(budget, UTF8.encode(path).byteLength + 6, 'state mutations');
    if (Object.hasOwn(entry, 'value') === Object.hasOwn(entry, 'delete')) {
      throw new TypeError(`mutation[${index}] must set or delete exactly once`);
    }
    if (Object.hasOwn(entry, 'value')) {
      output.push(Object.freeze({
        path,
        value: cloneProtocolValue(
          entry.value,
          `mutation[${index}].value`,
          1,
          budget,
          new Set(),
        ),
      }));
    } else {
      if (entry.delete !== true) throw new TypeError(`mutation[${index}].delete must be true`);
      output.push(Object.freeze({ path, delete: true }));
    }
  }
  return Object.freeze(output);
}

export function validateStateAccess(value: unknown): readonly UserStateAccess[] {
  if (!Array.isArray(value) || value.length > LIMITS.declarationsPerCoordinator) {
    throw new TypeError('state access declarations must be a bounded array');
  }
  const users = new Set<string>();
  const budget: ValueBudget = { values: 1, bytes: 5 };
  return Object.freeze(value.map((raw, index) => {
    const entry = exactObject(raw, ['userId', 'patterns'], [], `stateAccess[${index}]`);
    const userId = validateOpaqueId(entry.userId, `stateAccess[${index}].userId`);
    if (users.has(userId)) throw new TypeError('state access contains a duplicate user');
    users.add(userId);
    accountDeclarationValue(budget, UTF8.encode(userId).byteLength + 5, 'state access');
    return Object.freeze({
      userId,
      patterns: uniqueStrings(
        entry.patterns,
        validatePattern,
        `stateAccess[${index}].patterns`,
        budget,
      ),
    });
  }));
}

export function validateEventAccess(value: unknown): readonly UserEventAccess[] {
  if (!Array.isArray(value) || value.length > LIMITS.declarationsPerCoordinator) {
    throw new TypeError('event access declarations must be a bounded array');
  }
  const users = new Set<string>();
  const budget: ValueBudget = { values: 1, bytes: 5 };
  return Object.freeze(value.map((raw, index) => {
    const entry = exactObject(raw, ['userId', 'publish', 'subscribe'], [], `eventAccess[${index}]`);
    const userId = validateOpaqueId(entry.userId, `eventAccess[${index}].userId`);
    if (users.has(userId)) throw new TypeError('event access contains a duplicate user');
    users.add(userId);
    accountDeclarationValue(budget, UTF8.encode(userId).byteLength + 9, 'event access');
    return Object.freeze({
      userId,
      publish: uniqueStrings(
        entry.publish,
        validatePattern,
        `eventAccess[${index}].publish`,
        budget,
      ),
      subscribe: uniqueStrings(
        entry.subscribe,
        validatePattern,
        `eventAccess[${index}].subscribe`,
        budget,
      ),
    });
  }));
}

export function validateEventDeclarations(value: unknown): readonly EventDeclaration[] {
  if (!Array.isArray(value) || value.length > LIMITS.declarationsPerCoordinator) {
    throw new TypeError('event declarations must be a bounded array');
  }
  const topics = new Set<string>();
  const budget: ValueBudget = { values: 1, bytes: 5 };
  return Object.freeze(value.map((raw, index) => {
    const entry = exactObject(raw, ['topic', 'directions'], [], `events[${index}]`);
    const topic = validateStructuredName(entry.topic, `events[${index}].topic`);
    if (topics.has(topic)) throw new TypeError('event declarations contain a duplicate topic');
    topics.add(topic);
    accountDeclarationValue(budget, UTF8.encode(topic).byteLength + 10, 'event declarations');
    if (!Number.isInteger(entry.directions)
      || typeof entry.directions !== 'number'
      || entry.directions < 1
      || entry.directions > 0x0f) {
      throw new TypeError(`events[${index}].directions is invalid`);
    }
    return Object.freeze({ topic, directions: entry.directions });
  }));
}

export function validateFunctions(value: unknown): Readonly<Record<string, FunctionHandler>> {
  if (!isPlainRecord(value)) throw new TypeError('function declaration must be an object');
  const names = Object.keys(value);
  if (Reflect.ownKeys(value).length !== names.length
    || names.length > LIMITS.declarationsPerCoordinator) {
    throw new TypeError('function declaration has an invalid shape');
  }
  const output: Record<string, FunctionHandler> = Object.create(null);
  const budget: ValueBudget = { values: 1, bytes: 5 };
  for (const name of names) {
    validateStructuredName(name, `function ${name}`);
    if (name === 'miakapp.join') throw new TypeError('miakapp.join is reserved');
    const handler = value[name];
    if (!isFunctionHandler(handler)) throw new TypeError(`function ${name} has no handler`);
    accountDeclarationValue(budget, UTF8.encode(name).byteLength + 5, 'function declaration');
    output[name] = handler;
  }
  return Object.freeze(output);
}

function isFunctionHandler(value: unknown): value is FunctionHandler {
  return typeof value === 'function';
}

function isAccessTokenProvider(value: unknown): value is AccessTokenProvider {
  return value !== null
    && typeof value === 'object'
    && 'getAccessToken' in value
    && typeof value.getAccessToken === 'function';
}

function isCoordinatorLogger(value: unknown): value is CoordinatorLogger {
  return value !== null
    && typeof value === 'object'
    && 'write' in value
    && typeof value.write === 'function';
}

function isFirebaseIdTokenProvider(value: unknown): value is FirebaseIdTokenProvider {
  return value !== null
    && typeof value === 'object'
    && 'getIdToken' in value
    && typeof value.getIdToken === 'function';
}

function isBrowserClientLogger(value: unknown): value is BrowserClientLogger {
  return value !== null
    && typeof value === 'object'
    && 'write' in value
    && typeof value.write === 'function';
}

export function validateConfiguration(value: unknown): CoordinatorConfiguration {
  const configuration = exactObject(
    value,
    ['state', 'stateAccess', 'events', 'eventAccess', 'functions'],
    [],
    'configuration',
  );
  return Object.freeze({
    state: validateStateEntries(configuration.state),
    stateAccess: validateStateAccess(configuration.stateAccess),
    events: validateEventDeclarations(configuration.events),
    eventAccess: validateEventAccess(configuration.eventAccess),
    functions: validateFunctions(configuration.functions),
  });
}

export function validateCoordinatorOptions(value: unknown): CoordinatorOptions {
  const options = exactObject(value, ['name', 'accessTokenProvider'], ['logger'], 'options');
  const provider = options.accessTokenProvider;
  if (!isAccessTokenProvider(provider)) {
    throw new TypeError('options.accessTokenProvider must implement getAccessToken');
  }
  const logger = options.logger;
  if (logger !== undefined && !isCoordinatorLogger(logger)) {
    throw new TypeError('options.logger must implement write');
  }
  const name = validateCoordinatorName(options.name);
  return logger === undefined
    ? Object.freeze({ name, accessTokenProvider: provider })
    : Object.freeze({ name, accessTokenProvider: provider, logger });
}

export function validateAccessToken(value: unknown, now: number): AccessToken {
  const token = exactObject(value, ['relayUrl', 'token', 'expiresAtMs'], [], 'access token');
  const relayUrl = validateRelayUrl(token.relayUrl, 'access token relayUrl');
  const expiresAtMs = token.expiresAtMs;
  if (!Number.isSafeInteger(expiresAtMs)
    || typeof expiresAtMs !== 'number'
    || expiresAtMs <= now) {
    throw new RangeError('access token expiry must be a future safe integer');
  }
  return Object.freeze({
    relayUrl,
    token: boundedString(token.token, 1, 16_384, 'access token token', true),
    expiresAtMs,
  });
}

export function validateRelayUrl(value: unknown, label = 'relay URL'): string {
  const relayUrl = boundedString(value, 1, 2_048, label);
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (url.protocol !== 'wss:'
    || !url.hostname
    || url.username
    || url.password
    || url.hash
    || url.search
    || !url.pathname.endsWith('/ws')) {
    throw new TypeError(`${label} must be a secure WebSocket URL ending in /ws`);
  }
  return url.href;
}

export function validateFirebaseIdToken(value: unknown): string {
  return boundedString(value, 1, 16_384, 'Firebase ID token', true);
}

export function validateBrowserClientOptions(value: unknown): BrowserClientOptions {
  const options = exactObject(
    value,
    ['homeId', 'relayUrl', 'idTokenProvider'],
    ['logger'],
    'options',
  );
  const homeId = boundedString(options.homeId, 3, 63, 'options.homeId');
  if (!HOME_ID.test(homeId)) throw new TypeError('options.homeId is invalid');
  if (!isFirebaseIdTokenProvider(options.idTokenProvider)) {
    throw new TypeError('options.idTokenProvider must implement getIdToken');
  }
  if (options.logger !== undefined && !isBrowserClientLogger(options.logger)) {
    throw new TypeError('options.logger must implement write');
  }
  const base = Object.freeze({
    homeId,
    relayUrl: validateRelayUrl(options.relayUrl, 'options.relayUrl'),
    idTokenProvider: options.idTokenProvider,
  });
  return options.logger === undefined
    ? base
    : Object.freeze({ ...base, logger: options.logger });
}

export function validateBrowserCallOptions(value: unknown): BrowserCallOptions {
  const options = exactObject(
    value,
    ['function', 'arguments', 'timeoutMs'],
    ['idempotencyKey', 'signal'],
    'call options',
  );
  const validated = validateStartCallOptions(options);
  return Object.freeze({
    function: validated.function,
    arguments: validated.arguments,
    timeoutMs: validated.timeoutMs,
    ...(validated.idempotencyKey === undefined ? {} : { idempotencyKey: validated.idempotencyKey }),
    ...(validated.signal === undefined ? {} : { signal: validated.signal }),
  });
}

function validateTarget(value: unknown, label: string): EventTarget | CallTarget {
  const entry = exactObject(value, ['kind'], ['id'], label);
  if (entry.kind === 'default') {
    if (Object.hasOwn(entry, 'id')) throw new TypeError(`${label} default target has no id`);
    return Object.freeze({ kind: 'default' });
  }
  if (entry.kind === 'user_session') {
    if (!Number.isSafeInteger(entry.id) || typeof entry.id !== 'number' || entry.id < 1) {
      throw new TypeError(`${label}.id must be a positive session identifier`);
    }
    return Object.freeze({ kind: 'user_session', id: entry.id });
  }
  if (entry.kind === 'coordinator') {
    return Object.freeze({ kind: 'coordinator', id: validateCoordinatorName(entry.id, `${label}.id`) });
  }
  throw new TypeError(`${label}.kind is invalid`);
}

export function validateEventTarget(value: unknown): EventTarget {
  return validateTarget(value, 'event target');
}

export function validateStartCallOptions(value: unknown): StartCallOptions {
  const options = exactObject(
    value,
    ['function', 'arguments', 'timeoutMs'],
    ['target', 'idempotencyKey', 'signal'],
    'call options',
  );
  if (!Number.isInteger(options.timeoutMs)
    || typeof options.timeoutMs !== 'number'
    || options.timeoutMs < 1
    || options.timeoutMs > LIMITS.callTimeoutMs) {
    throw new RangeError('call options timeoutMs is out of range');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError('call options signal must be an AbortSignal');
  }
  const base = {
    function: validateStructuredName(options.function, 'call options function'),
    arguments: validateProtocolValue(options.arguments, 'call options arguments'),
    timeoutMs: options.timeoutMs,
  };
  const target = options.target === undefined ? undefined : validateTarget(options.target, 'call target');
  const idempotencyKey = options.idempotencyKey === undefined
    ? undefined
    : boundedString(options.idempotencyKey, 1, 128, 'call options idempotencyKey', true);
  if (target === undefined && idempotencyKey === undefined && options.signal === undefined) {
    return Object.freeze(base);
  }
  return Object.freeze({
    ...base,
    ...(target === undefined ? {} : { target }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export function validateSignal(value: unknown, label: string): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError(`${label} must be an AbortSignal`);
  return value;
}

export function validateStartOptions(value: unknown): AbortSignal | undefined {
  const options = exactObject(value, [], ['signal'], 'start options');
  return validateSignal(options.signal, 'start signal');
}

export function validateStopOptions(value: unknown): number {
  const options = exactObject(value, [], ['deadlineMs'], 'stop options');
  const deadlineMs = options.deadlineMs ?? 5_000;
  if (!Number.isSafeInteger(deadlineMs)
    || typeof deadlineMs !== 'number'
    || deadlineMs < 0
    || deadlineMs > 300_000) {
    throw new RangeError('stop deadlineMs must be between 0 and 300000');
  }
  return deadlineMs;
}

export function validateDeclarationOptions(value: unknown, label: string): AbortSignal | undefined {
  const options = exactObject(value, [], ['signal'], `${label} options`);
  return validateSignal(options.signal, `${label} signal`);
}

export function validateOperationOptions(value: unknown, label: string): AbortSignal | undefined {
  const options = exactObject(value, [], ['signal'], `${label} options`);
  return validateSignal(options.signal, `${label} signal`);
}

export function validateEventPublishOptions(value: unknown): {
  signal?: AbortSignal;
  target?: EventTarget;
} {
  const options = exactObject(value, [], ['signal', 'target'], 'event options');
  const signal = validateSignal(options.signal, 'event signal');
  const target = options.target === undefined ? undefined : validateEventTarget(options.target);
  if (signal === undefined) {
    if (target === undefined) return Object.freeze({});
    return Object.freeze({ target });
  }
  if (target === undefined) return Object.freeze({ signal });
  return Object.freeze({ signal, target });
}

export function targetFields(target: EventTarget | CallTarget | undefined): [number, ProtocolValue] {
  if (target === undefined || target.kind === 'default') return [0, null];
  if (target.kind === 'user_session') return [1, target.id];
  return [2, target.id];
}
