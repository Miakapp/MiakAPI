/**
 * Reading an installation that already exists.
 *
 * `docs/agent-guide.md` §3 tells an agent to characterize the house before
 * designing anything. This module is the part of that work a program can do:
 * it turns a Node-RED `flows.json` export into an inventory of brokers, flows,
 * topics and the V3 MiakAPI surface, and it reports which V3 names are already
 * legal V4 names.
 *
 * Three properties keep it honest:
 *
 * - **Offline and read-only.** It parses bytes handed to it. It opens no
 *   socket, contacts no broker and writes nothing back into the export.
 * - **It never drops a node silently.** Every unrecognized `type` is counted
 *   and reported, because the value of an inventory is knowing what it missed.
 * - **It never guesses semantics.** It reports what a node declares. Which
 *   actions are physically consequential is a judgement the reader makes from
 *   the listed surface; no keyword list decides it here.
 *
 * Field names come from the two schemas involved: Node-RED core `mqtt in`,
 * `mqtt out` and `mqtt-broker` node definitions, and the `node-red-contrib-
 * MiakAPI` v3 node definitions in `miakapi.html`.
 */
import { projectError } from './errors.js';
import { isDottedName, utf8Bytes } from './internal/names.js';

/**
 * A generous ceiling for a local export. The strict parser in `internal/json.ts`
 * is bounded for untrusted control-plane responses at 2,048 values, which a real
 * house blows through in the first tab; a flows export is an operator-supplied
 * local file, so the bound here is on bytes rather than on structure.
 */
export const MAXIMUM_FLOWS_BYTES = 33_554_432;

/** Keys that would poison a prototype if a record were ever spread. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const MIAKAPI_V3_TYPES = new Set([
  'initMiakapi',
  'getHomeUsers',
  'commitVariables',
  'onHomeReady',
  'onHomeUpdate',
  'onUserLogin',
  'onUserAction',
  'sendPushNotif',
  'reconnectMiakapi',
]);

export type FindingKind =
  /** A coordinator secret sits in cleartext in the export. */
  | 'secret_in_export'
  /** An action any signed-in user may invoke, because no group was listed. */
  | 'unrestricted_action'
  /** A V3 name that is not a legal V4 dotted name and has to be renamed. */
  | 'name_needs_rename'
  /** A subscription pattern rather than one device's topic. */
  | 'wildcard_subscription'
  /** A broker reached without TLS. */
  | 'broker_without_tls'
  /** A node type this inventory does not model. */
  | 'unmodelled_node';

export type FindingSeverity = 'critical' | 'attention' | 'note';

export interface Finding {
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  readonly detail: string;
  readonly nodeId: string | undefined;
}

export interface Broker {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number | undefined;
  readonly tls: boolean;
  readonly subscribes: readonly string[];
  readonly publishes: readonly string[];
}

export interface FlowTab {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly nodeCount: number;
}

export interface HomeBinding {
  readonly nodeId: string;
  readonly homeId: string;
  readonly coordinatorId: string;
  readonly secretInExport: boolean;
}

/** One `commitVariables` entry: a V3 variable path and where its value came from. */
export interface StateCandidate {
  readonly path: string;
  readonly source: 'jsonata' | 'env' | 'literal';
  readonly nodeId: string;
  readonly legalV4Name: boolean;
}

/** One `onUserAction` handler: the V3 shape of what becomes a V4 function. */
export interface ActionCandidate {
  readonly inputId: string;
  readonly allowedGroups: readonly string[];
  readonly nodeId: string;
  readonly legalV4Name: boolean;
}

/** One `sendPushNotif` node: the V3 shape of what becomes a V4 published event. */
export interface NotificationCandidate {
  readonly nodeId: string;
  readonly name: string;
  readonly adminOnly: boolean;
  readonly group: string;
}

export interface Inventory {
  readonly nodeCount: number;
  readonly flows: readonly FlowTab[];
  readonly brokers: readonly Broker[];
  readonly homes: readonly HomeBinding[];
  readonly state: readonly StateCandidate[];
  readonly actions: readonly ActionCandidate[];
  readonly notifications: readonly NotificationCandidate[];
  /** Every type this module does not model, with how many nodes carry it. */
  readonly unmodelled: readonly { readonly type: string; readonly count: number }[];
  readonly findings: readonly Finding[];
}

type Record_ = Readonly<Record<string, unknown>>;

function field(node: Record_, key: string): unknown {
  return Object.hasOwn(node, key) ? node[key] : undefined;
}

function text(node: Record_, key: string): string {
  const value = field(node, key);
  return typeof value === 'string' ? value : '';
}

function flag(node: Record_, key: string): boolean {
  return field(node, key) === true;
}

/** Node-RED writes `port` as either a number or a numeric string. */
function port(node: Record_): number | undefined {
  const value = field(node, 'port');
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]{1,5}$/.test(value)) return Number(value);
  return undefined;
}

function finding(
  kind: FindingKind,
  severity: FindingSeverity,
  detail: string,
  nodeId?: string,
): Finding {
  return Object.freeze({ kind, severity, detail, nodeId });
}

/**
 * Parses the export.
 *
 * A flows export is a flat array of node records; tabs, config nodes and wired
 * nodes all sit at the same level and refer to each other by `id`.
 */
function parseFlows(source: Uint8Array): readonly Record_[] {
  if (source.byteLength > MAXIMUM_FLOWS_BYTES) {
    throw projectError(
      `The flows export is larger than ${MAXIMUM_FLOWS_BYTES} bytes`,
      'Export one Node-RED instance at a time.',
    );
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw projectError('The flows export is not readable as UTF-8 text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw projectError(
      'The flows export is not valid JSON',
      'Use the file Node-RED writes, or the Export > All flows download, not a screenshot of it.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw projectError(
      'The flows export is not a JSON array of nodes',
      'A Node-RED export is a flat array; an object here is usually a single copied node.',
    );
  }
  const nodes: Record_[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // Values are only ever read through `Object.hasOwn`, never spread, so a
    // poisoned key cannot reach a prototype; it is dropped here regardless.
    if (Reflect.ownKeys(entry).some((key) => FORBIDDEN_KEYS.has(String(key)))) continue;
    if (typeof (entry as Record_)['type'] !== 'string') continue;
    nodes.push(entry as Record_);
  }
  return nodes;
}

function collectTabs(nodes: readonly Record_[]): readonly FlowTab[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const parent = text(node, 'z');
    if (parent !== '') counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return nodes
    .filter((node) => node['type'] === 'tab')
    .map((node) => {
      const id = text(node, 'id');
      return Object.freeze({
        id,
        label: text(node, 'label'),
        disabled: flag(node, 'disabled'),
        nodeCount: counts.get(id) ?? 0,
      });
    });
}

function collectBrokers(nodes: readonly Record_[], findings: Finding[]): readonly Broker[] {
  const subscribes = new Map<string, Set<string>>();
  const publishes = new Map<string, Set<string>>();

  for (const node of nodes) {
    const type = node['type'];
    if (type !== 'mqtt in' && type !== 'mqtt out') continue;
    const broker = text(node, 'broker');
    const topic = text(node, 'topic');
    if (broker === '') continue;
    if (topic === '') {
      // `mqtt in` with `topicType: dynamic` takes its topic from a message, so
      // the export cannot say which devices it will reach.
      findings.push(finding(
        'unmodelled_node',
        'attention',
        `${String(type)} node has no static topic; its subscription is set at runtime`,
        text(node, 'id'),
      ));
      continue;
    }
    const into = type === 'mqtt in' ? subscribes : publishes;
    const set = into.get(broker) ?? new Set<string>();
    set.add(topic);
    into.set(broker, set);
    if (type === 'mqtt in' && (topic.includes('#') || topic.includes('+'))) {
      findings.push(finding(
        'wildcard_subscription',
        'note',
        `Subscription ${topic} is a pattern, not one device; enumerate what it actually matches`,
        text(node, 'id'),
      ));
    }
  }

  return nodes
    .filter((node) => node['type'] === 'mqtt-broker')
    .map((node) => {
      const id = text(node, 'id');
      const host = text(node, 'broker');
      const tls = flag(node, 'usetls');
      if (!tls) {
        findings.push(finding(
          'broker_without_tls',
          'attention',
          `Broker ${host === '' ? id : host} is configured without TLS`,
          id,
        ));
      }
      return Object.freeze({
        id,
        name: text(node, 'name'),
        host,
        port: port(node),
        tls,
        subscribes: [...subscribes.get(id) ?? []].sort(),
        publishes: [...publishes.get(id) ?? []].sort(),
      });
    });
}

function collectHomes(nodes: readonly Record_[], findings: Finding[]): readonly HomeBinding[] {
  return nodes
    .filter((node) => node['type'] === 'initMiakapi')
    .map((node) => {
      const nodeId = text(node, 'id');
      // `coordSecret` is declared in the node's `defaults`, not in its
      // `credentials`, so Node-RED stores it in `flows.json` itself rather than
      // in the encrypted `flows_cred.json`.
      const secretInExport = text(node, 'coordSecret') !== '';
      if (secretInExport) {
        findings.push(finding(
          'secret_in_export',
          'critical',
          'A coordinator secret is stored in cleartext in this export; treat it as leaked, '
          + 'rotate it, and keep the export out of Git',
          nodeId,
        ));
      }
      return Object.freeze({
        nodeId,
        homeId: text(node, 'home'),
        coordinatorId: text(node, 'coordID'),
        secretInExport,
      });
    });
}

/**
 * Why a V3 name is not a legal V4 dotted name, in the words of the rule it
 * breaks. `isDottedName` answers yes or no; a reader who has to rename a path
 * needs to know which constraint bit them.
 */
function illegalNameReason(value: string): string {
  if (value === '') return 'it is empty';
  if (value.includes('*')) return 'it contains *, which V4 reserves for the trailing .* suffix';
  if (/\p{Cc}/u.test(value)) return 'it contains a control character';
  if (value.split('.').some((segment) => segment === '')) {
    return 'it has an empty dotted segment';
  }
  return `it is ${utf8Bytes(value)} UTF-8 bytes, outside the 1..256 range`;
}

function variableSource(type: unknown): 'jsonata' | 'env' | 'literal' {
  if (type === 'jsonata') return 'jsonata';
  if (type === 'env') return 'env';
  return 'literal';
}

function collectState(nodes: readonly Record_[], findings: Finding[]): readonly StateCandidate[] {
  const candidates: StateCandidate[] = [];
  for (const node of nodes) {
    if (node['type'] !== 'commitVariables') continue;
    const values = field(node, 'values');
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue;
    const nodeId = text(node, 'id');
    for (const path of Object.keys(values)) {
      if (FORBIDDEN_KEYS.has(path)) continue;
      const entry = (values as Record_)[path];
      const type = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record_)['type']
        : undefined;
      const legalV4Name = isDottedName(path);
      if (!legalV4Name) {
        findings.push(finding(
          'name_needs_rename',
          'attention',
          `Variable path ${path} is not a legal V4 state path: ${illegalNameReason(path)}; `
          + 'rename it before the household depends on it',
          nodeId,
        ));
      }
      candidates.push(Object.freeze({
        path,
        source: variableSource(type),
        nodeId,
        legalV4Name,
      }));
    }
  }
  return candidates.sort((left, right) => (left.path < right.path ? -1 : 1));
}

function collectActions(nodes: readonly Record_[], findings: Finding[]): readonly ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  for (const node of nodes) {
    if (node['type'] !== 'onUserAction') continue;
    const nodeId = text(node, 'id');
    const inputId = text(node, 'inputID');
    const raw = field(node, 'allowedGroups');
    const allowedGroups = Array.isArray(raw)
      ? raw.filter((group): group is string => typeof group === 'string')
      : [];
    // The v3 handler allows the action outright when no group is listed, so an
    // empty list is a grant to every signed-in user, not a deny.
    if (allowedGroups.length === 0) {
      findings.push(finding(
        'unrestricted_action',
        'critical',
        `Action ${inputId === '' ? nodeId : inputId} lists no group, so every signed-in user `
        + 'may invoke it; V4 needs an explicit rule for it',
        nodeId,
      ));
    }
    const legalV4Name = isDottedName(inputId);
    if (!legalV4Name) {
      findings.push(finding(
        'name_needs_rename',
        'attention',
        `Action id ${inputId === '' ? '(empty)' : inputId} is not a legal V4 function name: `
        + illegalNameReason(inputId),
        nodeId,
      ));
    }
    candidates.push(Object.freeze({ inputId, allowedGroups, nodeId, legalV4Name }));
  }
  return candidates.sort((left, right) => (left.inputId < right.inputId ? -1 : 1));
}

function collectNotifications(nodes: readonly Record_[]): readonly NotificationCandidate[] {
  return nodes
    .filter((node) => node['type'] === 'sendPushNotif')
    .map((node) => Object.freeze({
      nodeId: text(node, 'id'),
      name: text(node, 'name'),
      adminOnly: flag(node, 'adminOnly'),
      group: text(node, 'group'),
    }));
}

function collectUnmodelled(
  nodes: readonly Record_[],
  findings: Finding[],
): readonly { readonly type: string; readonly count: number }[] {
  const modelled = new Set(['tab', 'mqtt in', 'mqtt out', 'mqtt-broker', ...MIAKAPI_V3_TYPES]);
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const type = node['type'] as string;
    if (modelled.has(type)) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const unmodelled = [...counts]
    .map(([type, count]) => Object.freeze({ type, count }))
    .sort((left, right) => right.count - left.count || (left.type < right.type ? -1 : 1));
  if (unmodelled.length > 0) {
    findings.push(finding(
      'unmodelled_node',
      'note',
      `${unmodelled.length} node type(s) are not modelled by this inventory; `
      + 'read them yourself before assuming the house is fully described',
    ));
  }
  return unmodelled;
}

/**
 * Builds the inventory for one Node-RED export.
 *
 * The result is a pure function of the bytes: the same export always produces
 * the same report, which is what makes it usable as a migration baseline that
 * can be diffed between two runs.
 */
export function discoverFlows(source: Uint8Array): Inventory {
  const nodes = parseFlows(source);
  const findings: Finding[] = [];
  const flows = collectTabs(nodes);
  const brokers = collectBrokers(nodes, findings);
  const homes = collectHomes(nodes, findings);
  const state = collectState(nodes, findings);
  const actions = collectActions(nodes, findings);
  const notifications = collectNotifications(nodes);
  const unmodelled = collectUnmodelled(nodes, findings);
  const order: Record<FindingSeverity, number> = { critical: 0, attention: 1, note: 2 };
  return Object.freeze({
    nodeCount: nodes.length,
    flows,
    brokers,
    homes,
    state,
    actions,
    notifications,
    unmodelled,
    findings: findings.sort((left, right) => order[left.severity] - order[right.severity]),
  });
}

/** The JSON body of `miakapp discover --json`, with no secret value in it. */
export function inventoryJson(inventory: Inventory): Record<string, unknown> {
  return {
    node_count: inventory.nodeCount,
    flows: inventory.flows.map((tab) => ({
      id: tab.id,
      label: tab.label,
      disabled: tab.disabled,
      node_count: tab.nodeCount,
    })),
    brokers: inventory.brokers.map((broker) => ({
      id: broker.id,
      name: broker.name,
      host: broker.host,
      ...(broker.port === undefined ? {} : { port: broker.port }),
      tls: broker.tls,
      subscribes: broker.subscribes,
      publishes: broker.publishes,
    })),
    homes: inventory.homes.map((home) => ({
      node_id: home.nodeId,
      home_id: home.homeId,
      coordinator_id: home.coordinatorId,
      // The flag says a secret is present. The secret itself is never read out.
      secret_in_export: home.secretInExport,
    })),
    state: inventory.state.map((candidate) => ({
      path: candidate.path,
      source: candidate.source,
      node_id: candidate.nodeId,
      legal_v4_name: candidate.legalV4Name,
    })),
    actions: inventory.actions.map((candidate) => ({
      input_id: candidate.inputId,
      allowed_groups: candidate.allowedGroups,
      node_id: candidate.nodeId,
      legal_v4_name: candidate.legalV4Name,
    })),
    notifications: inventory.notifications.map((candidate) => ({
      node_id: candidate.nodeId,
      name: candidate.name,
      admin_only: candidate.adminOnly,
      group: candidate.group,
    })),
    unmodelled: inventory.unmodelled.map((entry) => ({
      type: entry.type,
      count: entry.count,
    })),
    findings: inventory.findings.map((item) => ({
      kind: item.kind,
      severity: item.severity,
      detail: item.detail,
      ...(item.nodeId === undefined || item.nodeId === '' ? {} : { node_id: item.nodeId }),
    })),
  };
}
