import { describe, expect, it } from 'vitest';

import {
  createModelMatcher,
  normalizeAgentId,
} from '../src/providers/provider-utils.ts';

describe('createModelMatcher', () => {
  it('matches a model that starts with the prefix', () => {
    const match = createModelMatcher('openai/');
    expect(match('openai/gpt-4o')).toBe(true);
  });

  it('rejects a model that does not start with the prefix', () => {
    const match = createModelMatcher('openai/');
    expect(match('anthropic/claude-3')).toBe(false);
  });

  it('is case-insensitive', () => {
    const match = createModelMatcher('OpenAI/');
    expect(match('openai/gpt-4o')).toBe(true);
    expect(match('OPENAI/GPT-4O')).toBe(true);
  });

  it('trims whitespace from both prefix and model', () => {
    const match = createModelMatcher('  openai/ ');
    expect(match(' openai/gpt-4o ')).toBe(true);
  });

  it('handles empty or nullish model gracefully', () => {
    const match = createModelMatcher('openai/');
    expect(match('')).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime safety with nullish values
    expect(match(null as any)).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime safety with nullish values
    expect(match(undefined as any)).toBe(false);
  });

  it('handles empty prefix (matches everything)', () => {
    const match = createModelMatcher('');
    expect(match('anything')).toBe(true);
  });
});

describe('normalizeAgentId', () => {
  it('returns the trimmed value when present', () => {
    expect(normalizeAgentId('  my-agent  ')).toBe('my-agent');
  });

  it('falls back to DEFAULT_AGENT_ID for empty string', () => {
    expect(normalizeAgentId('')).toBe('main');
  });

  it('falls back to DEFAULT_AGENT_ID for null', () => {
    expect(normalizeAgentId(null)).toBe('main');
  });

  it('falls back to DEFAULT_AGENT_ID for undefined', () => {
    expect(normalizeAgentId(undefined)).toBe('main');
  });

  it('falls back to DEFAULT_AGENT_ID for whitespace-only string', () => {
    expect(normalizeAgentId('   ')).toBe('main');
  });
});
