import { projectError } from '../errors.js';
import {
  MAXIMUM_REQUIREMENTS_PER_LIST,
  REQUIREMENT_KINDS,
  isValidRequirement,
  type RequirementKind,
  type Requirements,
} from './names.js';

/**
 * The closed RFC 0002 `requires` object. Lists are duplicate-free and sorted by
 * UTF-16 code unit so the value the CLI binds into an upload capability is
 * byte-identical on every later reconciliation read.
 */
export function canonicalRequirements(value: unknown): Requirements {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw projectError('requires must be an object with the five closed capability lists');
  }
  const unknown = Object.keys(value).filter(
    (key) => !(REQUIREMENT_KINDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw projectError(`requires has unknown capability lists: ${unknown.join(', ')}`);
  }
  const entries = REQUIREMENT_KINDS.map((kind) => [kind, list(value, kind)] as const);
  return Object.freeze(Object.fromEntries(entries)) as Requirements;
}

function list(source: object, kind: RequirementKind): readonly string[] {
  const value = (source as Record<string, unknown>)[kind];
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw projectError(`requires.${kind} must be an array`);
  if (value.length > MAXIMUM_REQUIREMENTS_PER_LIST) {
    throw projectError(
      `requires.${kind} exceeds ${MAXIMUM_REQUIREMENTS_PER_LIST} entries`,
    );
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidRequirement(kind, item)) {
      throw projectError(
        `requires.${kind} contains an invalid requirement: ${JSON.stringify(item)}`,
        kind === 'presentation'
          ? 'ABI 1 presentation requirements are exact media.* handles; wildcards are forbidden.'
          : 'Use an exact RFC 0001 dotted name or a dotted prefix ending in .*',
      );
    }
    if (seen.has(item as string)) {
      throw projectError(`requires.${kind} repeats ${JSON.stringify(item)}`);
    }
    seen.add(item as string);
  }
  return Object.freeze([...seen].sort());
}

/** Validates a `requires` object received from the control plane. */
export function sameRequirements(left: Requirements, right: Requirements): boolean {
  return REQUIREMENT_KINDS.every((kind) => {
    const a = left[kind];
    const b = right[kind];
    return a.length === b.length && a.every((item, index) => item === b[index]);
  });
}
