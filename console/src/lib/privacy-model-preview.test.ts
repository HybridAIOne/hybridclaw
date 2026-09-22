/**
 * Preview tests preserve vendor diversity and exact privacy-level membership.
 * They exercise display selection, not execution routing.
 */
import { expect, test } from 'vitest';
import type { ChatModel } from '../api/types';
import {
  isRoutingLanguageModel,
  privacyModelPreview,
} from './privacy-model-preview';

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

test('embedding and reranker models never appear in routing previews', () => {
  const models = [
    'lmstudio/text-embedding-nomic-embed-text-v1.5',
    'ollama/nomic-embed-text',
    'vllm/Qwen/Qwen3-Embedding-8B',
    'openai/text-embedding-3-large',
    'lmstudio/BAAI/bge-m3',
    'lmstudio/intfloat/multilingual-e5-large',
    'vllm/Qwen/Qwen3-Reranker-8B',
    'lmstudio/nvidia/nemotron-3-nano',
    'vllm/Qwen/Qwen3.6-27B-FP8',
  ].map((id) => ({ id, zone: 'local' })) as ChatModel[];
  expect(
    models.filter(isRoutingLanguageModel).map((model) => model.id),
  ).toEqual(['lmstudio/nvidia/nemotron-3-nano', 'vllm/Qwen/Qwen3.6-27B-FP8']);
  expect(
    privacyModelPreview(
      models,
      'local',
      models.map((model) => model.id),
    ),
  ).toHaveLength(2);
});
