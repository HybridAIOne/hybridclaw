import { describe, expect, test } from 'vitest';

import * as shared from '../container/shared/anthropic-utils.js';
import * as host from '../src/providers/anthropic-utils.js';

describe('Anthropic shared utilities', () => {
  test('host provider re-exports shared Anthropic normalization helpers', () => {
    expect(host.normalizeAnthropicModelName).toBe(
      shared.normalizeAnthropicModelName,
    );
    expect(host.stripAnthropicModelPrefix).toBe(
      shared.stripAnthropicModelPrefix,
    );
    expect(host.normalizeAnthropicBaseUrl).toBe(
      shared.normalizeAnthropicBaseUrl,
    );
    expect(host.isAnthropicOAuthToken).toBe(shared.isAnthropicOAuthToken);
  });

  test('normalizes Anthropic model names, runtime names, base URLs, and OAuth tokens', () => {
    expect(shared.normalizeAnthropicModelName('claude-sonnet-4-6')).toBe(
      'anthropic/claude-sonnet-4-6',
    );
    expect(
      shared.normalizeAnthropicModelName('anthropic/claude-sonnet-4-6'),
    ).toBe('anthropic/claude-sonnet-4-6');
    expect(
      shared.stripAnthropicModelPrefix('anthropic/claude-sonnet-4-6'),
    ).toBe('claude-sonnet-4-6');
    expect(shared.normalizeAnthropicBaseUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1',
    );
    expect(
      shared.normalizeAnthropicBaseUrl('https://api.anthropic.com/v1/'),
    ).toBe('https://api.anthropic.com/v1');
    expect(shared.isAnthropicOAuthToken('sk-ant-oat-example')).toBe(true);
    expect(shared.isAnthropicOAuthToken('sk-ant-api03-example')).toBe(false);
  });
});
