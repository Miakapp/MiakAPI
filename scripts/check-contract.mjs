#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinPath = join(root, 'contracts', 'miakapp-v3.json');
const subjectPath = join(root, '.contract-dist', 'test', 'contract', 'subject.js');
const defaultCheckout = join(root, '.contract', 'miakapp-v3');
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const ALLOWED_PIN_KEYS = new Set(['repository', 'commit', 'profile', 'schema']);

function validatePin(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Contract pin must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== ALLOWED_PIN_KEYS.size
    || keys.some((key) => !ALLOWED_PIN_KEYS.has(key))
    || typeof value.repository !== 'string'
    || !value.repository.startsWith('https://github.com/Miakapp/')
    || typeof value.commit !== 'string'
    || !GIT_OBJECT_ID.test(value.commit)
    || value.profile !== 'sdk'
    || value.schema !== 'miakapp.coordinator-contract/1') {
    throw new TypeError('Contract pin is invalid');
  }
  return value;
}

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        rejectRun(new Error(
          signal === null
            ? `${command} exited with code ${code}`
            : `${command} terminated by ${signal}`,
        ));
        return;
      }
      resolveRun(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

const pin = validatePin(JSON.parse(await readFile(pinPath, 'utf8')));
const suppliedCheckout = process.env.MIAKAPP_V3_CHECKOUT;
const checkout = suppliedCheckout === undefined
  ? defaultCheckout
  : resolve(suppliedCheckout);

if (suppliedCheckout === undefined && !await exists(join(checkout, '.git'))) {
  await mkdir(dirname(checkout), { recursive: true });
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', pin.repository, checkout]);
}
if (suppliedCheckout === undefined) {
  await run('git', ['-C', checkout, 'fetch', '--depth=1', 'origin', pin.commit]);
  await run('git', ['-C', checkout, 'checkout', '--detach', pin.commit]);
}

const actualCommit = await run(
  'git',
  ['-C', checkout, 'rev-parse', 'HEAD'],
  { capture: true },
);
if (actualCommit !== pin.commit) {
  throw new Error(`Contract checkout is ${actualCommit}; expected ${pin.commit}`);
}
const trackedChanges = await run(
  'git',
  ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'],
  { capture: true },
);
if (trackedChanges.length > 0) {
  throw new Error('Contract checkout contains tracked modifications');
}
if (!await exists(subjectPath)) {
  throw new Error('Contract subject is not built; run bun run build:contract first');
}

await run(
  join(checkout, 'coordinator-contract', 'check-external.sh'),
  ['--profile', pin.profile, subjectPath],
  { cwd: checkout },
);
