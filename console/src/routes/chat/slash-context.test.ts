import { describe, expect, it } from 'vitest';
import { getSlashContext } from './slash-context';

describe('getSlashContext', () => {
  it('returns null when there is no slash token', () => {
    expect(getSlashContext('', 0)).toBeNull();
    expect(getSlashContext('hello world', 11)).toBeNull();
    expect(getSlashContext('not /a slash either', 3)).toBeNull();
  });

  it('returns the leading slash token at the start of the input', () => {
    const ctx = getSlashContext('/clear', 6);
    expect(ctx).toEqual({ query: 'clear', tokenStart: 0, tokenEnd: 6 });
  });

  it('treats the bare slash as an empty query', () => {
    expect(getSlashContext('/', 1)).toEqual({
      query: '',
      tokenStart: 0,
      tokenEnd: 1,
    });
  });

  it('finds a slash token after a space (mid-line)', () => {
    const value = 'hello /clear';
    const ctx = getSlashContext(value, value.length);
    expect(ctx).toEqual({ query: 'clear', tokenStart: 6, tokenEnd: 12 });
  });

  it('captures only what the user has typed so far up to the cursor', () => {
    const value = 'hello /clear world';
    const ctx = getSlashContext(value, 'hello /cl'.length);
    expect(ctx).toEqual({ query: 'cl', tokenStart: 6, tokenEnd: 9 });
  });

  it('keeps the panel open across spaces so subcommands can be queried', () => {
    expect(getSlashContext('/agent ', 7)).toEqual({
      query: 'agent ',
      tokenStart: 0,
      tokenEnd: 7,
    });
    expect(getSlashContext('/agent install', 14)).toEqual({
      query: 'agent install',
      tokenStart: 0,
      tokenEnd: 14,
    });
    expect(getSlashContext('hello /agent install foo', 24)).toEqual({
      query: 'agent install foo',
      tokenStart: 6,
      tokenEnd: 24,
    });
  });

  it('a newline ends the slash command run', () => {
    expect(getSlashContext('/agent\nhello', 12)).toBeNull();
  });

  it('handles tab and newline as token separators', () => {
    expect(getSlashContext('foo\t/bar', 'foo\t/bar'.length))?.toMatchObject({
      query: 'bar',
    });
    expect(getSlashContext('foo\n/bar', 'foo\n/bar'.length))?.toMatchObject({
      query: 'bar',
    });
  });

  it('returns null when the token before the cursor does not start with /', () => {
    expect(getSlashContext('hello world', 5)).toBeNull();
  });
});
