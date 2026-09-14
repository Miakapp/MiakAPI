import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { projectError } from './errors.js';
import { canonicalHttpsUrl } from './internal/http.js';
import { isHomeId, isRelease, type Requirements } from './internal/names.js';
import { canonicalRequirements } from './internal/requirements.js';
import { parseYaml, type YamlMapping, type YamlValue } from './internal/yaml.js';

export const PROJECT_FILE = 'miakapp.yaml';
export const PROJECT_SCHEMA = 'miakapp.project/1';

export interface Project {
  readonly root: string;
  readonly homeId: string;
  readonly issuer: string;
  readonly artifactPath: string;
  readonly release: string;
  readonly requires: Requirements;
  readonly coordinatorEntry: string | undefined;
}

function mapping(value: YamlValue | undefined, label: string): YamlMapping {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') {
    throw projectError(`${label} must be a mapping`);
  }
  return value;
}

function exactKeys(source: YamlMapping, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw projectError(`${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

/**
 * Resolves a declared path inside the project root. An absolute path or one that
 * escapes the root is rejected so a published artifact always comes from the
 * repository the agent is working in.
 */
export function resolveProjectPath(root: string, declared: unknown, label: string): string {
  if (typeof declared !== 'string' || declared === '') {
    throw projectError(`${label} must be a relative path inside the project`);
  }
  if (isAbsolute(declared) || declared.includes('\0')) {
    throw projectError(`${label} must be relative to the project root`);
  }
  const normalized = normalize(declared);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw projectError(`${label} must not leave the project root`);
  }
  return join(root, normalized);
}

export function parseProject(root: string, source: string): Project {
  const document = parseYaml(source);
  exactKeys(document, ['schema', 'home', 'control_plane', 'component', 'coordinator'], PROJECT_FILE);
  if (document.schema !== PROJECT_SCHEMA) {
    throw projectError(
      `${PROJECT_FILE} must declare schema: ${PROJECT_SCHEMA}`,
      'Run miakapp init to generate a current project file.',
    );
  }
  if (!isHomeId(document.home)) {
    throw projectError(
      'home must be a Miakapp home ID of 3..63 bytes matching [a-z][a-z0-9-]*[a-z0-9]',
    );
  }
  const issuer = canonicalHttpsUrl(document.control_plane, 'control_plane');
  if (issuer.endsWith('/')) throw projectError('control_plane must not have a trailing slash');

  const component = mapping(document.component, 'component');
  exactKeys(component, ['artifact', 'release', 'requires'], 'component');
  if (!isRelease(component.release)) {
    throw projectError('component.release must be 1..64 UTF-8 bytes without control characters');
  }
  const requires = canonicalRequirements(
    component.requires === undefined || component.requires === null ? {} : component.requires,
  );

  let coordinatorEntry: string | undefined;
  if (document.coordinator !== undefined && document.coordinator !== null) {
    const coordinator = mapping(document.coordinator, 'coordinator');
    exactKeys(coordinator, ['entry'], 'coordinator');
    coordinatorEntry = resolveProjectPath(root, coordinator.entry, 'coordinator.entry');
  }

  return Object.freeze({
    root,
    homeId: document.home,
    issuer,
    artifactPath: resolveProjectPath(root, component.artifact, 'component.artifact'),
    release: component.release,
    requires,
    coordinatorEntry,
  });
}

/**
 * Walks up from `start` to find the project root. An agent may run the CLI from
 * any subdirectory of the repository it is editing.
 */
export async function findProjectFile(
  start: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, PROJECT_FILE);
    if (await exists(candidate)) return candidate;
    const parent = resolve(directory, '..');
    if (parent === directory) {
      throw projectError(
        `No ${PROJECT_FILE} found in ${start} or any parent directory`,
        'Run miakapp init to create one.',
      );
    }
    directory = parent;
  }
}
