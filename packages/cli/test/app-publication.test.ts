import { describe, expect, test } from 'bun:test';

import { fetchDiscovery, homeUrl, parseHomeUrlTemplate } from '../src/control-plane.js';
import { EXIT_CODE } from '../src/errors.js';
import { HOME_KEY_VARIABLE, run } from '../src/main.js';
import { parseProject } from '../src/project.js';
import { ISSUER, digestOf, fakeControlPlane, homeKey } from './support/control-plane.js';
import { MemoryFiles, PROJECT_ROOT, testHost } from './support/host.js';

const HOME_ID = 'test-home';
const APP_SOURCE = '(function () { document.body.textContent = "maison"; })();\n';
const APP_YAML = `schema: miakapp.project/1
home: ${HOME_ID}
control_plane: ${ISSUER}

app:
  artifact: dist/app.js
  release: 2026-10-03.1
  requires:
    state_read:
      - room.*
      - security.*
    call:
      - lighting.set
`;
const TEMPLATE = 'https://app.example.test/app?home={home_id}';

function appProject(yaml = APP_YAML): MemoryFiles {
  return new MemoryFiles({
    [`${PROJECT_ROOT}/miakapp.yaml`]: yaml,
    [`${PROJECT_ROOT}/dist/app.js`]: APP_SOURCE,
  });
}

describe('app manifest', () => {
  test('selects the whole-house ABI and keeps prefix requirements', () => {
    const project = parseProject(PROJECT_ROOT, APP_YAML);
    expect(project.abi).toBe('miakapp.app/1');
    expect(project.artifactPath).toBe(`${PROJECT_ROOT}/dist/app.js`);
    expect(project.requires.state_read).toEqual(['room.*', 'security.*']);
    expect(project.requires.call).toEqual(['lighting.set']);
  });

  test('refuses both or neither section, and anything the shell would not broker', () => {
    const refused = [
      APP_YAML.replace('app:', 'component:\n  artifact: a.js\n  release: x\napp:'),
      APP_YAML.replace(/app:[\s\S]*/u, ''),
      APP_YAML.replace('    call:', '    event_subscribe:\n      - door.opened\n    call:'),
      APP_YAML.replace('    call:', '    presentation:\n      - media.camera\n    call:'),
      APP_YAML.replace('      - lighting.set', '      - miakapp.join'),
      APP_YAML.replace('      - lighting.set', '      - miakapp.*'),
      APP_YAML.replace('  release: 2026-10-03.1', '  release: 2026-10-03.1\n  url: https://x'),
    ];
    for (const yaml of refused) expect(() => parseProject(PROJECT_ROOT, yaml)).toThrow();
  });
});

describe('discovery home link', () => {
  test('accepts exactly <origin>/app?home={home_id}', () => {
    expect(parseHomeUrlTemplate(TEMPLATE)).toBe(TEMPLATE);
    expect(homeUrl({ homeUrlTemplate: TEMPLATE }, 'maison-a')).toBe('https://app.example.test/app?home=maison-a');
    expect(homeUrl({}, 'maison-a')).toBeNull();
    for (const bad of [
      'http://app.example.test/app?home={home_id}',
      'https://app.example.test/x/app?home={home_id}',
      'https://user@app.example.test/app?home={home_id}',
      'https://app.example.test/app?home={home_id}&next=https://evil.example',
      'https://app.example.test/v1/components/{home_id}.js',
      'https://app.example.test/app?home=fixed',
    ]) {
      expect(() => parseHomeUrlTemplate(bad)).toThrow();
    }
  });

  test('accepts the optional members a current control plane sends, and checks them', async () => {
    const accepted = fakeControlPlane({
      homeId: HOME_ID,
      discoveryExtras: {
        runtime_diagnostics_endpoint: `${ISSUER}/v1/runtime-diagnostics`,
        home_url_template: TEMPLATE,
      },
    });
    const discovery = await fetchDiscovery({ issuer: ISSUER, fetch: accepted.fetch });
    expect(discovery.homeUrlTemplate).toBe(TEMPLATE);

    const foreign = fakeControlPlane({
      homeId: HOME_ID,
      discoveryExtras: { runtime_diagnostics_endpoint: 'https://elsewhere.example/v1/runtime-diagnostics' },
    });
    await expect(fetchDiscovery({ issuer: ISSUER, fetch: foreign.fetch })).rejects.toThrow();
    const unknown = fakeControlPlane({ homeId: HOME_ID, discoveryExtras: { surprise: 'x' } });
    await expect(fetchDiscovery({ issuer: ISSUER, fetch: unknown.fetch })).rejects.toThrow();
  });
});

describe('app publication', () => {
  test('publishes miakapp.app/1 and prints the resident link apart from the artifact', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0, discoveryExtras: { home_url_template: TEMPLATE } });
    const host = testHost({ files: appProject(), fetch: plane.fetch, env: { [HOME_KEY_VARIABLE]: homeKey() } });
    expect(await run(['publish', '--json'], host)).toBe(EXIT_CODE.success);
    const result = host.json();
    expect(result['abi']).toBe('miakapp.app/1');
    expect(result['home_url']).toBe(`https://app.example.test/app?home=${HOME_ID}`);
    const digest = digestOf(new TextEncoder().encode(APP_SOURCE));
    expect(result['url']).toBe(`${ISSUER}/v1/components/${digest}.js`);
    expect(result['home_url']).not.toBe(result['url']);
    expect([...plane.uploads.values()][0]?.abi).toBe('miakapp.app/1');

    const human = testHost({ files: appProject(), fetch: plane.fetch, env: { [HOME_KEY_VARIABLE]: homeKey() } });
    expect(await run(['status'], human)).toBe(EXIT_CODE.success);
    expect(human.stdout()).toContain(`home_url: https://app.example.test/app?home=${HOME_ID}`);
    expect(human.stdout()).toContain('artifact_url: ');
    expect(human.stdout()).not.toMatch(/^url:/mu);
  });

  test('says no resident link is advertised rather than inventing one', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const host = testHost({ files: appProject(), fetch: plane.fetch, env: { [HOME_KEY_VARIABLE]: homeKey() } });
    expect(await run(['publish', '--json'], host)).toBe(EXIT_CODE.success);
    expect(host.json()['home_url']).toBeNull();
  });

  test('refuses a control plane that echoes another ABI', async () => {
    const plane = fakeControlPlane({ homeId: HOME_ID, generation: 0 });
    const original = plane.fetch;
    const tampering = async (input: string, init: RequestInit) => {
      if (init.method === 'POST' && input.endsWith('/component-uploads')) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return await original(input, { ...init, body: JSON.stringify({ ...body, abi: 'miakapp.component/1' }) });
      }
      return await original(input, init);
    };
    const host = testHost({ files: appProject(), fetch: tampering, env: { [HOME_KEY_VARIABLE]: homeKey() } });
    expect(await run(['publish'], host)).toBe(EXIT_CODE.contract);
    expect(plane.generation).toBe(0);
  });
});
