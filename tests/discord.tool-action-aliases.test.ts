import { expect, test } from 'vitest';

import { normalizeDiscordToolAction } from '../src/channels/discord/tool-actions.js';

test('normalizes send aliases to send', () => {
  expect(normalizeDiscordToolAction('dm')).toBe('send');
  expect(normalizeDiscordToolAction('post')).toBe('send');
  expect(normalizeDiscordToolAction('reply')).toBe('send');
  expect(normalizeDiscordToolAction('respond')).toBe('send');
  expect(normalizeDiscordToolAction('send_message')).toBe('send');
});

test('normalizes read aliases to read', () => {
  expect(normalizeDiscordToolAction('history')).toBe('read');
  expect(normalizeDiscordToolAction('fetch')).toBe('read');
  expect(normalizeDiscordToolAction('read-messages')).toBe('read');
});

test('normalizes member lookup aliases to member-info', () => {
  expect(normalizeDiscordToolAction('lookup')).toBe('member-info');
  expect(normalizeDiscordToolAction('whois')).toBe('member-info');
  expect(normalizeDiscordToolAction('member_info')).toBe('member-info');
});

test('returns null for unknown actions', () => {
  expect(normalizeDiscordToolAction('poll')).toBe(null);
  expect(normalizeDiscordToolAction('')).toBe(null);
});
