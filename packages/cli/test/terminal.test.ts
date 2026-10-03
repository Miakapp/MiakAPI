import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { readSecret, type SecretInput } from '../src/terminal.js';

const PACKAGE_DIRECTORY = resolve(import.meta.dir, '..');

class FakeTerminal extends EventEmitter {
  readonly isTTY = true;
  readonly modes: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.modes.push(mode);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    // A terminal is read through `data` events in raw mode, never iterated.
    throw new Error('iterated a terminal');
  }
}

describe('reading a secret', () => {
  test('a pipe yields its first line and nothing is echoed', async () => {
    const echoed: string[] = [];
    const value = await readSecret(
      Readable.from(['ABCD-', 'EFGH\nsecond line\n']) as unknown as SecretInput,
      'Pairing code: ',
      (text) => void echoed.push(text),
    );
    expect(value).toBe('ABCD-EFGH');
    expect(echoed).toEqual([]);
  });

  test('a terminal is prompted in raw mode, without echo, and restored', async () => {
    const terminal = new FakeTerminal();
    const echoed: string[] = [];
    const pending = readSecret(terminal, 'Pairing code: ', (text) => void echoed.push(text));
    terminal.emit('data', 'ABX');
    terminal.emit('data', '\u007fC-12\r');
    expect(await pending).toBe('ABC-12');
    expect(terminal.modes).toEqual([true, false]);
    expect(echoed.join('')).toBe('Pairing code: \n');
  });

  test('Ctrl-C on a terminal cancels and restores the terminal', async () => {
    const terminal = new FakeTerminal();
    const pending = readSecret(terminal, '> ', () => {});
    terminal.emit('data', 'AB\u0003');
    await expect(pending).rejects.toThrow('Cancelled');
    expect(terminal.modes).toEqual([true, false]);
  });
});

describe('the built executable', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'miakapp-bin-'));
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: PACKAGE_DIRECTORY, stdout: 'pipe', stderr: 'pipe' });
    expect(build.exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('pair reads the code from a pipe and never sends it to an unproven issuer', () => {
    const code = 'PIPE-CODE-1234';
    const result = Bun.spawnSync(
      ['node', 'bin/miakapp.js', 'pair', '--issuer', 'https://127.0.0.1:9', '--json'],
      {
        cwd: PACKAGE_DIRECTORY,
        stdin: new TextEncoder().encode(`${code}\n`),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, MIAKAPP_CONFIG_DIR: directory, MIAKAPP_HOME_KEY: '' },
      },
    );
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(stderr)).toMatchObject({ ok: false, kind: 'contract' });
    expect(stderr).toContain('The code was not sent');
    expect(stderr + result.stdout.toString()).not.toContain(code);
  });

  test('context list works from a fresh process with no environment export', () => {
    const result = Bun.spawnSync(['node', 'bin/miakapp.js', 'context', 'list', '--json'], {
      cwd: PACKAGE_DIRECTORY,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, MIAKAPP_CONFIG_DIR: directory },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: true,
      config_directory: directory,
      contexts: [],
    });
  });
});
