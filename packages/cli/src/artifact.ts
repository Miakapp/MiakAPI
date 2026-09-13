import { createHash } from 'node:crypto';
import { artifactError } from './errors.js';
import {
  MAXIMUM_ARTIFACT_BYTES,
  MAXIMUM_PROGRAM_TOKENS,
} from './internal/names.js';

export interface Artifact {
  /** Exact bytes that will be uploaded; nothing re-encodes them later. */
  readonly bytes: Uint8Array;
  /** SHA-256 of those bytes as unpadded base64url, per RFC 0002 §7.1. */
  readonly sha256: string;
  readonly size: number;
  readonly tokens: number;
}

export type ArtifactFindingKind =
  | 'module_syntax'
  | 'dynamic_import'
  | 'source_map_directive'
  | 'token_ceiling'
  | 'unterminated';

export interface ArtifactFinding {
  readonly kind: ArtifactFindingKind;
  readonly line: number;
  readonly detail: string;
}

const IDENTIFIER_START = /[$_\p{ID_Start}]/u;
const IDENTIFIER_PART = /[$_\u200c\u200d\p{ID_Continue}]/u;

/**
 * Tokens after which a `/` starts a regular expression rather than a division.
 * The list is deliberately conservative: a wrong guess only changes how the
 * scanner counts, never whether the broker's pinned parser accepts the program.
 */
const REGEX_ALLOWED_AFTER = new Set([
  'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return',
  'throw', 'typeof', 'void', 'yield',
]);

function isRegexPosition(previous: string | undefined): boolean {
  if (previous === undefined) return true;
  if (REGEX_ALLOWED_AFTER.has(previous)) return true;
  if (/^[A-Za-z_$]/.test(previous)) return false;
  if (/^[0-9]/.test(previous)) return false;
  return previous !== ')' && previous !== ']' && previous !== '}' && previous !== '++'
    && previous !== '--' && previous[0] !== '"' && previous[0] !== "'" && previous[0] !== '`';
}

/**
 * Publisher pre-check for the RFC 0002 §7.2 artifact rules.
 *
 * RFC 0002 makes the broker's pinned platform parser authoritative; this scan
 * exists so an agent learns about module syntax, a dynamic import, a source-map
 * directive or an oversized program before spending an upload capability. It
 * reports findings rather than throwing, so one run can show every problem.
 */
export function scanArtifactSource(source: string): {
  tokens: number;
  findings: readonly ArtifactFinding[];
} {
  const findings: ArtifactFinding[] = [];
  let index = 0;
  let line = 1;
  let tokens = 0;
  let previous: string | undefined;
  let lineStartOnlyWhitespace = true;

  const record = (kind: ArtifactFindingKind, detail: string): void => {
    if (findings.some((finding) => finding.kind === kind && finding.line === line)) return;
    findings.push({ kind, line, detail });
  };

  const advanceLines = (text: string): void => {
    for (const character of text) if (character === '\n') line += 1;
  };

  while (index < source.length) {
    const character = source[index] as string;
    if (character === '\n') {
      line += 1;
      lineStartOnlyWhitespace = true;
      index += 1;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\r' || character === '\f'
      || character === '\v' || character === '\u00a0' || character === '\ufeff') {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      const comment = source.slice(index, end === -1 ? source.length : end);
      if (/^\/\/[#@]\s*sourceMappingURL=/.test(comment)) {
        record('source_map_directive', comment.trim());
      }
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) {
        record('unterminated', 'Unterminated block comment');
        break;
      }
      const comment = source.slice(index, end + 2);
      if (/^\/\*[#@]\s*sourceMappingURL=/.test(comment)) {
        record('source_map_directive', comment.slice(0, 64));
      }
      advanceLines(comment);
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const end = scanQuoted(source, index, character);
      if (end === -1) {
        record('unterminated', 'Unterminated string literal');
        break;
      }
      advanceLines(source.slice(index, end));
      previous = `${character}string`;
      tokens += 1;
      index = end;
      lineStartOnlyWhitespace = false;
      continue;
    }
    if (character === '`') {
      const end = scanTemplate(source, index);
      if (end === -1) {
        record('unterminated', 'Unterminated template literal');
        break;
      }
      advanceLines(source.slice(index, end));
      previous = '`template';
      tokens += 1;
      index = end;
      lineStartOnlyWhitespace = false;
      continue;
    }
    if (character === '/' && isRegexPosition(previous)) {
      const end = scanRegex(source, index);
      if (end === -1) {
        record('unterminated', 'Unterminated regular expression literal');
        break;
      }
      previous = '/regex';
      tokens += 1;
      index = end;
      lineStartOnlyWhitespace = false;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end] as string)) end += 1;
      const word = source.slice(index, end);
      if (word === 'import') {
        const next = nextSignificant(source, end);
        if (next === '(') record('dynamic_import', 'import( expression');
        else if (next === '.') record('dynamic_import', 'import.meta reference');
        else record('module_syntax', 'import declaration');
      } else if (word === 'export' && lineStartOnlyWhitespace) {
        record('module_syntax', 'export declaration');
      }
      previous = word;
      tokens += 1;
      index = end;
      lineStartOnlyWhitespace = false;
      continue;
    }
    if (character >= '0' && character <= '9') {
      let end = index + 1;
      while (end < source.length && /[0-9a-fA-FxXoObBn._]/.test(source[end] as string)) end += 1;
      previous = source.slice(index, end);
      tokens += 1;
      index = end;
      lineStartOnlyWhitespace = false;
      continue;
    }
    const punctuator = scanPunctuator(source, index);
    previous = punctuator;
    tokens += 1;
    index += punctuator.length;
    lineStartOnlyWhitespace = false;
    if (tokens > MAXIMUM_PROGRAM_TOKENS) break;
  }

  if (tokens > MAXIMUM_PROGRAM_TOKENS) {
    findings.push({
      kind: 'token_ceiling',
      line,
      detail: `Program exceeds the ABI 1 ceiling of ${MAXIMUM_PROGRAM_TOKENS} lexical tokens`,
    });
  }
  return { tokens, findings };
}

function scanQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === '\n') return -1;
    index += 1;
  }
  return -1;
}

function scanTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '`') return index + 1;
    if (character === '$' && source[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        else if (inner === '`') {
          const nested = scanTemplate(source, index);
          if (nested === -1) return -1;
          index = nested;
          continue;
        } else if (inner === '"' || inner === "'") {
          const nested = scanQuoted(source, index, inner);
          if (nested === -1) return -1;
          index = nested;
          continue;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return -1;
}

function scanRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '\n') return -1;
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      index += 1;
      while (index < source.length && IDENTIFIER_PART.test(source[index] as string)) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
}

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
];

function scanPunctuator(source: string, index: number): string {
  for (const punctuator of PUNCTUATORS) {
    if (source.startsWith(punctuator, index)) return punctuator;
  }
  return source[index] as string;
}

function nextSignificant(source: string, from: number): string | undefined {
  let index = from;
  while (index < source.length) {
    const character = source[index] as string;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      if (end === -1) return undefined;
      index = end + 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) return undefined;
      index = end + 2;
      continue;
    }
    return character;
  }
  return undefined;
}

/**
 * Verifies the exact bytes an upload would deliver and derives the digest and
 * size that bind the upload capability.
 */
export function prepareArtifact(bytes: Uint8Array): Artifact {
  if (bytes.byteLength === 0) throw artifactError('Artifact is empty');
  if (bytes.byteLength > MAXIMUM_ARTIFACT_BYTES) {
    throw artifactError(
      `Artifact is ${bytes.byteLength} bytes, above the ABI 1 ceiling of ${MAXIMUM_ARTIFACT_BYTES}`,
    );
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw artifactError('Artifact is not valid UTF-8');
  }
  const { tokens, findings } = scanArtifactSource(source);
  if (findings.length > 0) {
    const detail = findings
      .map((finding) => `  line ${finding.line}: ${finding.kind} — ${finding.detail}`)
      .join('\n');
    throw artifactError(
      `Artifact violates the RFC 0002 §7.2 artifact rules:\n${detail}`,
      'Bundle to one self-contained classic Worker program with no module syntax, '
      + 'no dynamic import and no source map.',
    );
  }
  return Object.freeze({
    bytes,
    sha256: createHash('sha256').update(bytes).digest('base64url'),
    size: bytes.byteLength,
    tokens,
  });
}
