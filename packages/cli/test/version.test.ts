import { describe, expect, test } from 'bun:test';

import { CLI_VERSION, PACKAGE_NAME } from '../src/version.js';
import { serverEntry } from '../src/agent-pack.js';

const manifest = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
  name: string;
  version: string;
};

describe('package identity', () => {
  // These two constants are a hand-kept duplicate of the manifest. That is
  // tolerable only while something compares them: `agent-pack` writes
  // `name@version` into someone else's repository, so a stale constant
  // silently pins a release that is not the one shipping the guide next to it.
  test('CLI_VERSION matches the published manifest version', () => {
    expect(CLI_VERSION).toBe(manifest.version);
  });

  test('PACKAGE_NAME matches the published manifest name', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
  });
});

describe('the MCP entry the pack installs', () => {
  // A fresh owner repository has no globally installed `miakapp`; the entry has
  // to bring its own tool. This asserts the property, not the spelling.
  test('names no bare binary that a fresh repository would lack', () => {
    const entry = serverEntry();
    expect(entry['command']).not.toBe('miakapp');
  });

  test('resolves the exact published release through npx', () => {
    expect(serverEntry()).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', `${manifest.name}@${manifest.version}`, 'mcp'],
    });
  });

  test('carries no absolute path from the machine that wrote it', () => {
    const entry = serverEntry();
    const words = [entry['command'] as string, ...(entry['args'] as string[])];
    for (const word of words) {
      expect(word.startsWith('/')).toBe(false);
    }
  });
});
