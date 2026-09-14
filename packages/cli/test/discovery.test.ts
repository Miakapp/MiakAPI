import { describe, expect, test } from 'bun:test';
import { discoverFlows, MAXIMUM_FLOWS_BYTES } from '../src/discovery.js';
import { EXIT_CODE } from '../src/errors.js';
import { run } from '../src/main.js';
import { MemoryFiles, testHost } from './support/host.js';
import { FLOWS_EXPORT, FLOWS_PATH, flowsProject } from './support/flows.js';

function inventory(export_ = FLOWS_EXPORT) {
  return discoverFlows(new TextEncoder().encode(export_));
}

function findingKinds(export_ = FLOWS_EXPORT): string[] {
  return inventory(export_).findings.map((item) => item.kind);
}

describe('reading a flows export', () => {
  test('an export that is not JSON is a project failure, not a crash', () => {
    expect(() => discoverFlows(new TextEncoder().encode('not json'))).toThrow(/not valid JSON/);
  });

  test('a single copied node is rejected with the reason', () => {
    expect(() => discoverFlows(new TextEncoder().encode('{"id":"a","type":"tab"}')))
      .toThrow(/not a JSON array/);
  });

  test('an empty export inventories nothing rather than failing', () => {
    const empty = inventory('[]');
    expect(empty.nodeCount).toBe(0);
    expect(empty.flows).toEqual([]);
    expect(empty.findings).toEqual([]);
  });

  test('an export above the byte ceiling is refused before it is parsed', () => {
    const oversize = new Uint8Array(MAXIMUM_FLOWS_BYTES + 1);
    expect(() => discoverFlows(oversize)).toThrow(/larger than/);
  });

  test('a node without a string type is skipped, not counted', () => {
    expect(inventory('[{"id":"a"},{"id":"b","type":7},{"id":"c","type":"tab"}]').nodeCount).toBe(1);
  });

  test('a prototype-polluting key never reaches the inventory', () => {
    const poisoned = '[{"id":"a","type":"tab","__proto__":{"polluted":true}}]';
    expect(inventory(poisoned).nodeCount).toBe(0);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('the inventory of a house', () => {
  test('every tab is reported with how many nodes it holds', () => {
    const tabs = inventory().flows;
    expect(tabs.map((tab) => tab.label)).toEqual(['Salon', 'Chauffage']);
    expect(tabs[0]?.nodeCount).toBe(5);
    expect(tabs[1]?.disabled).toBe(true);
  });

  test('a broker carries the topics its nodes actually reach', () => {
    const broker = inventory().brokers[0];
    expect(broker?.host).toBe('192.168.1.10');
    expect(broker?.port).toBe(1883);
    expect(broker?.subscribes).toEqual(['maison/salon/#', 'maison/salon/temperature']);
    expect(broker?.publishes).toEqual(['maison/salon/lampe/set']);
  });

  test('the home binding is reported without reading the secret out', () => {
    const home = inventory().homes[0];
    expect(home?.homeId).toBe('maison-colmon');
    expect(home?.coordinatorId).toBe('coord-1');
    expect(home?.secretInExport).toBe(true);
    expect(JSON.stringify(inventory())).not.toContain('s3cr3t-in-the-file');
  });

  test('committed variables become state candidates, sorted and name-checked', () => {
    const state = inventory().state;
    expect(state.map((entry) => entry.path)).toEqual([
      'chauffage.consigne',
      'salon.*.on',
      'salon.lampe.on',
      'salon.temperature',
      'salon/humidite',
    ]);
    expect(state.find((entry) => entry.path === 'salon.temperature')?.source).toBe('jsonata');
    expect(state.find((entry) => entry.path === 'chauffage.consigne')?.source).toBe('env');
    expect(state.find((entry) => entry.path === 'salon.lampe.on')?.source).toBe('literal');
    expect(state.find((entry) => entry.path === 'salon/humidite')?.legalV4Name).toBe(true);
  });

  test('user actions become function candidates with their groups', () => {
    const actions = inventory().actions;
    expect(actions.map((entry) => entry.inputId)).toEqual(['chauffage.set', 'salon.lampe.toggle']);
    expect(actions[0]?.allowedGroups).toEqual(['adultes']);
    expect(actions[1]?.allowedGroups).toEqual([]);
  });

  test('notifications are reported with the audience they were sent to', () => {
    const notification = inventory().notifications[0];
    expect(notification?.adminOnly).toBe(true);
    expect(notification?.group).toBe('');
  });

  test('a node type the inventory does not model is counted, never dropped', () => {
    const unmodelled = inventory().unmodelled;
    expect(unmodelled).toEqual([
      { type: 'function', count: 2 },
      { type: 'inject', count: 1 },
    ]);
  });
});

describe('what the inventory refuses to leave unsaid', () => {
  test('a coordinator secret in the export is reported as critical', () => {
    const secret = inventory().findings.find((item) => item.kind === 'secret_in_export');
    expect(secret?.severity).toBe('critical');
    expect(secret?.detail).toContain('rotate');
  });

  test('an action with no group is reported as reachable by every user', () => {
    const open = inventory().findings.find((item) => item.kind === 'unrestricted_action');
    expect(open?.severity).toBe('critical');
    expect(open?.detail).toContain('salon.lampe.toggle');
  });

  test('a V3 name that V4 would reject is reported for rename', () => {
    const rename = inventory().findings.filter((item) => item.kind === 'name_needs_rename');
    expect(rename.map((item) => item.detail).join(' ')).toContain('salon.*.on');
  });

  test('a wildcard subscription is separated from a device topic', () => {
    const wildcard = inventory().findings.find((item) => item.kind === 'wildcard_subscription');
    expect(wildcard?.detail).toContain('maison/salon/#');
  });

  test('a broker without TLS is reported', () => {
    expect(findingKinds()).toContain('broker_without_tls');
  });

  test('critical findings sort ahead of notes', () => {
    const severities = inventory().findings.map((item) => item.severity);
    expect(severities).toEqual([...severities].sort(
      (left, right) => ['critical', 'attention', 'note'].indexOf(left)
        - ['critical', 'attention', 'note'].indexOf(right),
    ));
  });

  test('a house with nothing wrong reports no finding', () => {
    const clean = inventory(JSON.stringify([
      { id: 't1', type: 'tab', label: 'Salon' },
      { id: 'b1', type: 'mqtt-broker', name: 'local', broker: 'mqtt.example.test', port: '8883', usetls: true },
      { id: 'i1', type: 'initMiakapi', z: 't1', home: 'maison', coordID: 'c1', coordSecret: '' },
      { id: 'a1', type: 'onUserAction', z: 't1', inputID: 'salon.lampe.toggle', allowedGroups: ['adultes'] },
    ]));
    expect(clean.findings).toEqual([]);
  });
});

describe('the discover command', () => {
  test('it reports the house without needing a project file', async () => {
    const host = testHost({ files: flowsProject() });
    expect(await run(['discover', '--flows', FLOWS_PATH], host)).toBe(EXIT_CODE.success);
    expect(host.stdout()).toContain('5 state paths');
    expect(host.stdout()).toContain('192.168.1.10:1883');
  });

  test('--json emits one closed object an agent can branch on', async () => {
    const host = testHost({ files: flowsProject() });
    expect(await run(['discover', '--flows', FLOWS_PATH, '--json'], host)).toBe(EXIT_CODE.success);
    const report = host.json();
    expect(report['ok']).toBe(true);
    expect(report['command']).toBe('discover');
    expect(report['node_count']).toBe(15);
    expect((report['homes'] as Record<string, unknown>[])[0]?.['secret_in_export']).toBe(true);
    expect(JSON.stringify(report)).not.toContain('s3cr3t-in-the-file');
  });

  test('a missing export is a project failure with the path in it', async () => {
    const host = testHost({ files: new MemoryFiles() });
    expect(await run(['discover', '--flows', '/tmp/absent.json'], host)).toBe(EXIT_CODE.project);
    expect(host.stderr()).toContain('/tmp/absent.json');
  });

  test('discover without --flows is a usage failure', async () => {
    const host = testHost({ files: flowsProject() });
    expect(await run(['discover'], host)).toBe(EXIT_CODE.usage);
    expect(host.stderr()).toContain('--flows is required');
  });

  test('discover rejects a publication option', async () => {
    const host = testHost({ files: flowsProject() });
    expect(await run(['discover', '--flows', FLOWS_PATH, '--generation', '2'], host))
      .toBe(EXIT_CODE.usage);
  });
});
