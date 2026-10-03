#!/usr/bin/env node
import { run } from '../dist/main.js';
import { readSecret } from '../dist/terminal.js';

const writeError = (text) => void process.stderr.write(text);

process.exitCode = await run(process.argv.slice(2), {
  write: (text) => void process.stdout.write(text),
  writeError,
  cwd: () => process.cwd(),
  env: (name) => process.env[name],
  input: process.stdin,
  readSecret: (prompt) => readSecret(process.stdin, prompt, writeError),
});
