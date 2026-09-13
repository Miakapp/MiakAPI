#!/usr/bin/env node
import { run } from '../dist/main.js';

process.exitCode = await run(process.argv.slice(2), {
  write: (text) => void process.stdout.write(text),
  writeError: (text) => void process.stderr.write(text),
  cwd: () => process.cwd(),
  env: (name) => process.env[name],
});
