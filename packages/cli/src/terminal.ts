/**
 * Reads one secret line from stdin without ever echoing it.
 *
 * On a terminal the prompt goes to stderr and the terminal is put in raw mode,
 * so the code is neither displayed nor kept in the scrollback. From a pipe —
 * `printf %s "$CODE" | miakapp pair`, the form an agent uses — the first line
 * is read and the rest ignored. Either way the value never reaches argv, so it
 * is absent from shell history and from the process list.
 */
import { usageError } from './errors.js';

const MAXIMUM_SECRET_BYTES = 4_096;

export interface SecretInput extends AsyncIterable<Uint8Array | string> {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on?(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  off?(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

function text(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
}

async function readPipe(input: SecretInput): Promise<string> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += text(chunk);
    const newline = buffer.search(/\r?\n/);
    if (newline !== -1) return buffer.slice(0, newline);
    if (buffer.length > MAXIMUM_SECRET_BYTES) throw usageError('The secret on stdin is too long');
  }
  return buffer;
}

function readTerminal(input: SecretInput, writeError: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (outcome: () => void): void => {
      input.off?.('data', onData);
      input.setRawMode?.(false);
      input.pause?.();
      writeError('\n');
      outcome();
    };
    const onData = (chunk: Uint8Array | string): void => {
      for (const character of text(chunk)) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish(() => resolve(value));
          return;
        }
        if (character === '\u0003') {
          finish(() => reject(usageError('Cancelled')));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
        if (value.length > MAXIMUM_SECRET_BYTES) {
          finish(() => reject(usageError('The secret is too long')));
          return;
        }
      }
    };
    input.setRawMode?.(true);
    input.on?.('data', onData);
    input.resume?.();
  });
}

export async function readSecret(
  input: SecretInput,
  prompt: string,
  writeError: (text: string) => void,
): Promise<string> {
  if (input.isTTY === true && input.setRawMode !== undefined && input.on !== undefined) {
    writeError(prompt);
    return await readTerminal(input, writeError);
  }
  return await readPipe(input);
}
