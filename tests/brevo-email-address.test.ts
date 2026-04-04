import { describe, expect, test } from 'vitest';

import {
  resolveAgentEmailAddress,
  resolveAgentIdFromRecipient,
} from '../plugins/brevo-email/src/brevo-address.js';

describe('resolveAgentEmailAddress', () => {
  test('builds default address from agentId and domain', () => {
    expect(resolveAgentEmailAddress('marketing', 'mail.hybridclaw.io')).toBe(
      'marketing@mail.hybridclaw.io',
    );
  });

  test('uses override when provided', () => {
    expect(
      resolveAgentEmailAddress('marketing', 'mail.hybridclaw.io', 'custom@example.com'),
    ).toBe('custom@example.com');
  });

  test('trims override whitespace', () => {
    expect(
      resolveAgentEmailAddress('main', 'mail.hybridclaw.io', '  trimmed@example.com  '),
    ).toBe('trimmed@example.com');
  });

  test('falls back to default when override is empty string', () => {
    expect(resolveAgentEmailAddress('main', 'mail.hybridclaw.io', '')).toBe(
      'main@mail.hybridclaw.io',
    );
  });

  test('falls back to default when override is null', () => {
    expect(resolveAgentEmailAddress('main', 'mail.hybridclaw.io', null)).toBe(
      'main@mail.hybridclaw.io',
    );
  });

  test('falls back to default when override is undefined', () => {
    expect(resolveAgentEmailAddress('main', 'mail.hybridclaw.io', undefined)).toBe(
      'main@mail.hybridclaw.io',
    );
  });
});

describe('resolveAgentIdFromRecipient', () => {
  const domain = 'mail.hybridclaw.io';

  test('extracts agent ID from matching domain', () => {
    expect(resolveAgentIdFromRecipient('marketing@mail.hybridclaw.io', domain)).toBe(
      'marketing',
    );
  });

  test('normalises to lowercase', () => {
    expect(resolveAgentIdFromRecipient('Marketing@Mail.HybridClaw.IO', domain)).toBe(
      'marketing',
    );
  });

  test('trims whitespace', () => {
    expect(resolveAgentIdFromRecipient('  main@mail.hybridclaw.io  ', domain)).toBe(
      'main',
    );
  });

  test('returns null for non-matching domain', () => {
    expect(resolveAgentIdFromRecipient('user@other.com', domain)).toBeNull();
  });

  test('returns null for address without @', () => {
    expect(resolveAgentIdFromRecipient('no-at-sign', domain)).toBeNull();
  });

  test('returns null for empty local part', () => {
    expect(resolveAgentIdFromRecipient('@mail.hybridclaw.io', domain)).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(resolveAgentIdFromRecipient('', domain)).toBeNull();
  });

  test('returns null for null-ish input', () => {
    expect(resolveAgentIdFromRecipient(null, domain)).toBeNull();
    expect(resolveAgentIdFromRecipient(undefined, domain)).toBeNull();
  });

  test('handles subaddressing (plus addressing)', () => {
    expect(
      resolveAgentIdFromRecipient('main+tag@mail.hybridclaw.io', domain),
    ).toBe('main+tag');
  });
});
