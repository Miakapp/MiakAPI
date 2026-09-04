import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'miakapi-browser-smoke-'));
const output = path.join(directory, 'browser.js');

try {
  const build = spawnSync(
    'bun',
    ['build', 'src/browser.ts', '--target=browser', '--outfile', output],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  if (build.status !== 0) {
    throw new Error(`Browser bundle failed:\n${build.stderr || build.stdout}`);
  }
  const source = await readFile(output, 'utf8');
  const forbidden = [
    /from\s+["']node:/u,
    /require\(["']node:/u,
    /from\s+["']ws["']/u,
    /require\(["']ws["']\)/u,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error('Browser bundle contains a Node-only import');
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'miakapi.browser-bundle-smoke/1',
    bytes: Buffer.byteLength(source),
    node_imports: false,
  })}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
