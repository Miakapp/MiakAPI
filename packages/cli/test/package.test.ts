import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const PACKAGE_DIRECTORY = resolve(import.meta.dir, '..');
const manifest = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
  scripts?: Record<string, string>;
};

interface PackResult {
  files: Array<{ path: string }>;
}

describe('the published package', () => {
  test('builds the executable payload during prepack', () => {
    expect(manifest.scripts?.['prepack']).toBe('bun run build');

    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: PACKAGE_DIRECTORY,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(build.exitCode).toBe(0);

    const packed = Bun.spawnSync(
      ['npm', 'pack', '--dry-run', '--ignore-scripts', '--json'],
      {
        cwd: PACKAGE_DIRECTORY,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(packed.exitCode).toBe(0);

    const results = JSON.parse(packed.stdout.toString()) as PackResult[];
    const files = results[0]?.files.map(({ path }) => path).sort() ?? [];
    expect(files).toContain('assets/agent-guide.md');
    expect(files).toContain('bin/miakapp.js');
    expect(files).toContain('dist/main.js');
    // The app starter is copied out of the installed package, so every file it
    // writes must ship in the tarball.
    for (const asset of ['tsconfig.json', 'app/main.ts', 'app/miakapp.ts', 'app/README.md']) {
      expect(files).toContain(`assets/starter/app/${asset}`);
    }
    expect(files).toContain('dist/starter.js');
  });
});
