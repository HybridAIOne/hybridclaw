import { describe, expect, it } from 'vitest';
import {
  parseAuditSearch,
  removeAuditField,
  setAuditField,
} from './audit-search';

describe('parseAuditSearch', () => {
  it('extracts session and type tokens', () => {
    expect(parseAuditSearch('session:web type:tool error here')).toEqual({
      sessionId: 'web',
      eventType: 'tool',
      query: 'error here',
    });
  });

  it('treats unknown keys as free text', () => {
    expect(parseAuditSearch('runId:foo:bar payload value')).toEqual({
      sessionId: '',
      eventType: '',
      query: 'runId:foo:bar payload value',
    });
  });

  it('accepts `event:` as an alias for `type:`', () => {
    expect(parseAuditSearch('event:session.end')).toEqual({
      sessionId: '',
      eventType: 'session.end',
      query: '',
    });
  });

  it('respects quoted values that contain spaces', () => {
    expect(parseAuditSearch('session:"web user" hello')).toEqual({
      sessionId: 'web user',
      eventType: '',
      query: 'hello',
    });
  });

  it('keeps quoted free text segments together', () => {
    expect(parseAuditSearch('"some payload"')).toEqual({
      sessionId: '',
      eventType: '',
      query: 'some payload',
    });
  });

  it('lets later field tokens override earlier ones', () => {
    expect(parseAuditSearch('type:tool type:session')).toEqual({
      sessionId: '',
      eventType: 'session',
      query: '',
    });
  });

  it('returns empty fields for empty input', () => {
    expect(parseAuditSearch('   ')).toEqual({
      sessionId: '',
      eventType: '',
      query: '',
    });
  });

  it('treats an empty field value as "clear this filter"', () => {
    // Pins UX: typing `type:` on its own erases any prior `type:` token
    // rather than searching for the literal string "type:".
    expect(parseAuditSearch('type:tool type:')).toEqual({
      sessionId: '',
      eventType: '',
      query: '',
    });
  });

  it('tolerates an unterminated leading quote on a field value', () => {
    // Mid-type state: `session:"web` should still produce a usable
    // sessionId rather than leaking the stray `"` to the API.
    expect(parseAuditSearch('session:"web')).toEqual({
      sessionId: 'web',
      eventType: '',
      query: '',
    });
  });

  it('tolerates an unterminated leading quote on free text', () => {
    expect(parseAuditSearch('"hello')).toEqual({
      sessionId: '',
      eventType: '',
      query: 'hello',
    });
  });
});

describe('removeAuditField', () => {
  it('removes the named field and keeps the rest', () => {
    expect(removeAuditField('session:web type:tool error', 'session')).toBe(
      'type:tool error',
    );
  });

  it('is a no-op when the field is absent', () => {
    expect(removeAuditField('hello world', 'type')).toBe('hello world');
  });
});

describe('setAuditField', () => {
  it('adds a field when none is present', () => {
    expect(setAuditField('error', 'type', 'tool')).toBe('error type:tool');
  });

  it('replaces an existing field', () => {
    expect(setAuditField('type:tool error', 'type', 'session')).toBe(
      'error type:session',
    );
  });

  it('clears the field when value is empty', () => {
    expect(setAuditField('type:tool error', 'type', '')).toBe('error');
  });

  it('quotes values with whitespace', () => {
    expect(setAuditField('', 'session', 'web user')).toBe('session:"web user"');
  });
});
