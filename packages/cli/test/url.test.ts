import { describe, expect, test } from 'bun:test';
import { canonicalHttpsUrl } from '../src/internal/http.js';

describe('canonicalHttpsUrl', () => {
  test('accepts the bare origin RFC 0004 §3 uses as its example issuer', () => {
    expect(canonicalHttpsUrl('https://control.example.test', 'issuer'))
      .toBe('https://control.example.test');
  });

  test('accepts an origin written with its trailing slash', () => {
    expect(canonicalHttpsUrl('https://control.example.test/', 'issuer'))
      .toBe('https://control.example.test/');
  });

  test('accepts an exact path identifier', () => {
    expect(canonicalHttpsUrl('https://control.example.test/api', 'issuer'))
      .toBe('https://control.example.test/api');
  });

  test('relaxing the empty path does not relax anything else', () => {
    const rejected = [
      'http://control.example.test',
      'https://control.example.test?a=1',
      'https://control.example.test#fragment',
      'https://user:secret@control.example.test',
      'https://control.example.test:443',
      'https://control.example.test/a/../b',
      'https://CONTROL.example.test',
      'wss://control.example.test',
      'control.example.test',
      '',
    ];
    for (const value of rejected) {
      expect(() => canonicalHttpsUrl(value, 'issuer')).toThrow();
    }
  });

  test('a non-string is refused', () => {
    expect(() => canonicalHttpsUrl(undefined, 'issuer')).toThrow();
    expect(() => canonicalHttpsUrl(42, 'issuer')).toThrow();
  });
});
