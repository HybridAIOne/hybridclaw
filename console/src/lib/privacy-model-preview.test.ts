/**
 * Preview tests preserve vendor diversity and exact privacy-level membership.
 * They exercise display selection, not execution routing.
 */
import { expect, test } from 'vitest';
import type { ChatModel } from '../api/types';
import { privacyModelPreview } from './privacy-model-preview';

test('previews prefer configured equivalents and different makers, excluding old and duplicate routes', () => {
  const ids = [
    'anthropic/claude-3-haiku',
    'anthropic/claude-opus-5',
    'openrouter/anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5',
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-sol:batch',
    'xai/grok-4',
  ];
  const models = ids.map((id) => ({ id, zone: 'cloud' })) as ChatModel[];
  const result = privacyModelPreview(models, 'cloud', [
    'hybridai/anthropic/claude-opus-5',
    'hybridai/gpt-5.6-sol',
  ]);
  expect(result.map((model) => model.id.split('/').at(-1))).toEqual([
    'claude-opus-5',
    'gpt-5.6-sol',
    'grok-4',
  ]);
});
test('a level with one maker can still show three distinct models', () => {
  const models = ['large', 'medium', 'small'].map((size) => ({
    id: `mistral/mistral-${size}`,
    zone: 'eu-provider',
  })) as ChatModel[];
  expect(privacyModelPreview(models, 'eu-provider', [])).toHaveLength(3);
  expect(privacyModelPreview(models, 'region', [])).toEqual([]);
});
