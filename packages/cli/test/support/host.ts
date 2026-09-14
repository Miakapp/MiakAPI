import type { CliHost, FileSystem } from '../../src/main.js';
import type { FetchLike } from '../../src/internal/http.js';

export const PROJECT_ROOT = '/home/mathieu/lumiere';

export const ARTIFACT_SOURCE = "self.addEventListener('fetch', function () {});\n";

export const PROJECT_YAML = `schema: miakapp.project/1
home: test-home
control_plane: https://control.example.test/api

component:
  artifact: dist/component.js
  release: 2026-09-13.1
  requires:
    state_read:
      - climate.living_room.temperature
    event_subscribe: []
    event_publish: []
    call:
      - lighting.set
    presentation: []
`;

export class MemoryFiles implements FileSystem {
  readonly entries: Map<string, Uint8Array>;

  constructor(entries: Record<string, string> = {}) {
    this.entries = new Map(
      Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]),
    );
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.entries.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
    return bytes;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (this.entries.has(path)) throw new Error(`EEXIST: ${path}`);
    this.entries.set(path, bytes);
  }

  async exists(path: string): Promise<boolean> {
    return this.entries.has(path);
  }

  text(path: string): string {
    const bytes = this.entries.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(bytes);
  }
}

export interface TestHost extends CliHost {
  readonly out: string[];
  readonly err: string[];
  stdout(): string;
  stderr(): string;
  json(): Record<string, unknown>;
}

export function testHost(options: {
  files?: FileSystem;
  fetch?: FetchLike;
  env?: Record<string, string>;
  cwd?: string;
} = {}): TestHost {
  const out: string[] = [];
  const err: string[] = [];
  const environment = options.env ?? {};
  return {
    out,
    err,
    write: (text) => void out.push(text),
    writeError: (text) => void err.push(text),
    cwd: () => options.cwd ?? PROJECT_ROOT,
    env: (name) => environment[name],
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    json: () => JSON.parse(out.join('')) as Record<string, unknown>,
  };
}

/** A project laid out the way `miakapp init` leaves it, with a built artifact. */
export function standardProject(artifact = ARTIFACT_SOURCE): MemoryFiles {
  return new MemoryFiles({
    [`${PROJECT_ROOT}/miakapp.yaml`]: PROJECT_YAML,
    [`${PROJECT_ROOT}/dist/component.js`]: artifact,
  });
}
