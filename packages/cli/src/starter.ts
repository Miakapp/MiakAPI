/**
 * The app starter `miakapp init --starter app` writes beside `miakapp.yaml`.
 *
 * It exists so that a new agent with nothing but the published CLI can reach a
 * buildable, checkable whole-house application: no source repository, no
 * unpublished package. Everything is copied out of this package's `assets/`,
 * except `package.json`, whose build script must name the artifact the
 * manifest declares.
 *
 * `app/miakapp.ts` is the `@miakapp/app` SDK source, byte for byte: the bridge
 * a starter ships is the canonical one, never a second hand-written protocol.
 * A test fails when the two drift.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { usageError } from './errors.js';
import { CLI_VERSION, PACKAGE_NAME } from './version.js';

export const STARTERS = ['app'] as const;
export type Starter = (typeof STARTERS)[number];

/** Copied verbatim from `assets/starter/app/`, in this order. */
export const STARTER_ASSETS = ['tsconfig.json', 'app/main.ts', 'app/miakapp.ts', 'app/README.md'] as const;

/** Every file the starter writes besides the manifest, relative to the project root. */
export const STARTER_FILES = ['package.json', ...STARTER_ASSETS] as const;

/** The TypeScript the starter's typecheck script pins; the version this repository builds with. */
export const STARTER_TYPESCRIPT = '7.0.2';

/**
 * A path the build script can name without shell quoting. The manifest parser
 * already keeps it inside the project; this keeps it out of the shell's way.
 */
const SCRIPT_SAFE_ARTIFACT = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.js$/;

export function isStarter(value: string): value is Starter {
  return (STARTERS as readonly string[]).includes(value);
}

export function starterAssetPath(relative: string): string {
  return fileURLToPath(new URL(`../assets/starter/app/${relative}`, import.meta.url));
}

export function validateStarterArtifact(artifact: string): void {
  if (!SCRIPT_SAFE_ARTIFACT.test(artifact)
    || (STARTER_FILES as readonly string[]).includes(artifact)
    || artifact === 'miakapp.yaml') {
    throw usageError(
      `--artifact ${JSON.stringify(artifact)} cannot be used with --starter app`,
      'Use a relative .js path of letters, digits, ".", "_", "-" and "/" that is not a starter '
      + 'file, such as dist/app.js.',
    );
  }
}

function packageJson(home: string, artifact: string): string {
  return `${JSON.stringify({
    name: `miakapp-home-${home}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { bun: '>=1.2.23', node: '>=22.9' },
    scripts: {
      build: `bun build app/main.ts --format=iife --minify --outfile ${artifact}`,
      typecheck: 'tsc --noEmit',
      check: 'bun run build && miakapp check',
    },
    devDependencies: {
      [PACKAGE_NAME]: CLI_VERSION,
      typescript: STARTER_TYPESCRIPT,
    },
  }, null, 2)}\n`;
}

/** The starter's files, as bytes, keyed by their path relative to the project root. */
export async function starterFiles(options: {
  readonly home: string;
  readonly artifact: string;
}): Promise<ReadonlyArray<readonly [path: string, bytes: Uint8Array]>> {
  const files: Array<readonly [string, Uint8Array]> = [
    ['package.json', new TextEncoder().encode(packageJson(options.home, options.artifact))],
  ];
  for (const relative of STARTER_ASSETS) {
    files.push([relative, new Uint8Array(await readFile(starterAssetPath(relative)))]);
  }
  return files;
}
