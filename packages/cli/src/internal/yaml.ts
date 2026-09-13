import { projectError } from '../errors.js';

/**
 * A deliberately closed YAML subset for `miakapp.yaml`.
 *
 * The configuration file is authored by humans and agents, so it stays readable
 * YAML; everything beyond the subset below is rejected with the offending line
 * rather than interpreted. This keeps the CLI dependency-free and keeps the
 * grammar small enough to reason about.
 *
 * Supported: block mappings, block sequences of scalars, two-space indentation,
 * `#` comments, plain scalars, single- and double-quoted scalars, `true`,
 * `false`, `null`, `~`, JSON numbers and the empty sequence `[]`.
 *
 * `[]` is the one flow form accepted, because RFC 0002's `requires` object is
 * closed at five lists and a home that requests no capability of a given kind
 * must still be able to write that list down. A non-empty flow sequence stays
 * rejected: it has a block form.
 *
 * Rejected: tabs, anchors, aliases, tags, non-empty flow collections,
 * multi-line scalars, multiple documents, duplicate keys and merge keys.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping;

export interface YamlMapping {
  readonly [key: string]: YamlValue;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAXIMUM_LINES = 2_048;
const MAXIMUM_DEPTH = 8;

interface Line {
  readonly number: number;
  readonly indent: number;
  readonly content: string;
}

function fail(line: number, message: string): never {
  throw projectError(`miakapp.yaml line ${line}: ${message}`);
}

function stripComment(raw: string, number: number): string {
  let quote: string | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote !== undefined) {
      if (character === '\\' && quote === '"') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(raw[index - 1] as string))) {
      return raw.slice(0, index).trimEnd();
    }
  }
  if (quote !== undefined) fail(number, 'unterminated quoted scalar');
  return raw.trimEnd();
}

function readLines(source: string): Line[] {
  const lines: Line[] = [];
  const raw = source.split('\n');
  if (raw.length > MAXIMUM_LINES) {
    throw projectError(`miakapp.yaml exceeds ${MAXIMUM_LINES} lines`);
  }
  raw.forEach((text, offset) => {
    const number = offset + 1;
    if (text.includes('\t')) fail(number, 'tabs are not permitted');
    if (text.includes('\r')) fail(number, 'carriage returns are not permitted');
    const content = stripComment(text, number);
    if (content.trim() === '') return;
    if (content.trimStart() === '---' || content.trimStart() === '...') {
      fail(number, 'document markers are not permitted');
    }
    const indent = content.length - content.trimStart().length;
    if (indent % 2 !== 0) fail(number, 'indentation must be a multiple of two spaces');
    lines.push({ number, indent, content: content.trimStart() });
  });
  return lines;
}

function parseScalar(text: string, number: number): YamlValue {
  if (text === '') return '';
  const first = text[0] as string;
  if (first === '"' || first === "'") {
    if (text.length < 2 || !text.endsWith(first)) fail(number, 'unterminated quoted scalar');
    const inner = text.slice(1, -1);
    if (first === "'") {
      if (inner.includes("'")) fail(number, "single-quoted escapes are not supported");
      return inner;
    }
    try {
      const decoded = JSON.parse(text) as unknown;
      if (typeof decoded !== 'string') fail(number, 'invalid double-quoted scalar');
      return decoded;
    } catch {
      return fail(number, 'invalid double-quoted scalar');
    }
  }
  if (text === '[]') return [];
  if ('&*!|>%@`'.includes(first) || first === '[' || first === '{') {
    fail(number, `the ${first} scalar form is not supported`);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (NUMBER.test(text)) {
    const number_ = Number(text);
    if (!Number.isFinite(number_)) fail(number, 'number is not finite');
    return number_;
  }
  if (text.includes(': ') || text.endsWith(':')) {
    fail(number, 'a plain scalar cannot contain a mapping separator');
  }
  return text;
}

function parseBlock(lines: Line[], from: number, indent: number, depth: number): {
  value: YamlValue;
  next: number;
} {
  if (depth > MAXIMUM_DEPTH) {
    fail((lines[from] as Line).number, `nesting exceeds ${MAXIMUM_DEPTH} levels`);
  }
  const first = lines[from];
  if (first === undefined) fail(0, 'unexpected end of file');
  if (first.content.startsWith('- ') || first.content === '-') {
    const items: YamlValue[] = [];
    let index = from;
    while (index < lines.length) {
      const line = lines[index] as Line;
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.number, 'unexpected indentation inside a sequence');
      if (!line.content.startsWith('- ') && line.content !== '-') {
        fail(line.number, 'a sequence cannot be mixed with mapping keys');
      }
      if (line.content === '-') fail(line.number, 'a sequence item must be a scalar');
      items.push(parseScalar(line.content.slice(2).trim(), line.number));
      index += 1;
    }
    return { value: items, next: index };
  }

  const mapping: Record<string, YamlValue> = Object.create(null) as Record<string, YamlValue>;
  const seen = new Set<string>();
  let index = from;
  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) fail(line.number, 'unexpected indentation');
    const separator = line.content.indexOf(':');
    if (separator === -1) fail(line.number, 'expected a "key: value" mapping entry');
    const key = line.content.slice(0, separator);
    if (!KEY.test(key)) fail(line.number, `invalid key ${JSON.stringify(key)}`);
    if (FORBIDDEN_KEYS.has(key)) fail(line.number, `the key ${key} is forbidden`);
    if (seen.has(key)) fail(line.number, `duplicate key ${key}`);
    seen.add(key);
    const rest = line.content.slice(separator + 1).trim();
    if (rest !== '') {
      mapping[key] = parseScalar(rest, line.number);
      index += 1;
      continue;
    }
    const child = lines[index + 1];
    if (child === undefined || child.indent <= indent) {
      mapping[key] = null;
      index += 1;
      continue;
    }
    if (child.indent !== indent + 2) fail(child.number, 'a nested block indents by two spaces');
    const block = parseBlock(lines, index + 1, child.indent, depth + 1);
    mapping[key] = block.value;
    index = block.next;
  }
  return { value: mapping, next: index };
}

export function parseYaml(source: string): YamlMapping {
  const lines = readLines(source);
  if (lines.length === 0) throw projectError('miakapp.yaml is empty');
  const first = lines[0] as Line;
  if (first.indent !== 0) fail(first.number, 'the document must start at column one');
  const { value, next } = parseBlock(lines, 0, 0, 1);
  if (next !== lines.length) fail((lines[next] as Line).number, 'unexpected trailing content');
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    throw projectError('miakapp.yaml must be a mapping');
  }
  return value;
}
