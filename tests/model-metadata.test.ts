import { expect, test } from 'vitest';
import {
  isGpt5ModelId,
  resolveStaticModelCatalogMetadata,
} from '../src/providers/model-metadata.js';

test.each([
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
])('isGpt5ModelId accepts canonical GPT-5 model id %s', (modelId) => {
  expect(isGpt5ModelId(modelId)).toBe(true);
});

test.each([
  'openai-codex/gpt-5',
  'hybridai/gpt-5-mini',
  'gpt-5:latest',
  'openai/gpt-5:latest',
  'openai-codex/gpt-5.1-codex-max:latest',
])('isGpt5ModelId accepts normalized GPT-5 variant %s', (modelId) => {
  expect(isGpt5ModelId(modelId)).toBe(true);
});

test.each([
  '',
  '  ',
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.5-pro',
])('isGpt5ModelId rejects non-overlay GPT-5 family input %s', (modelId) => {
  expect(isGpt5ModelId(modelId)).toBe(false);
});

test('Claude Sonnet 5 has current context and output limits', () => {
  expect(
    resolveStaticModelCatalogMetadata(
      'hybridai/anthropic/claude-sonnet-5',
    ),
  ).toMatchObject({
    known: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    capabilities: {
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
  });
});

test.each([
  ['openai/gpt-5.6-sol', 1_050_000],
  ['openai/gpt-5.6-terra', 1_050_000],
  ['openai/gpt-5.6-luna', 400_000],
])('%s has current OpenAI context and output limits', (model, contextWindow) => {
  expect(resolveStaticModelCatalogMetadata(model)).toMatchObject({
    known: true,
    contextWindow,
    maxTokens: 128_000,
    capabilities: {
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
  });
});
