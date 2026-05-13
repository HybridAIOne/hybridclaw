import { expect, expectTypeOf, test } from 'vitest';
import type {
  ModelOverlay,
  StaticModelMetadataEntry,
} from '../src/providers/model-metadata.js';
import {
  getModelOverlay,
  isCodexFamilyModelId,
  isGpt5ModelId,
  isLocalLlmModelId,
  listStaticModelMetadataModelIds,
} from '../src/providers/model-metadata.js';

const COMPLETE_OVERLAY = {
  tool_discipline: 'use tools deliberately',
  completion_contract: 'return the final answer only after work is complete',
  execution_policy: 'execute only approved actions',
  narrate_only_retry: true,
} satisfies ModelOverlay;

test('static model metadata entries accept an optional complete overlay', () => {
  const entryWithoutOverlay = {
    contextWindow: 400_000,
    capabilities: {
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
    sources: ['test-source'],
  } satisfies StaticModelMetadataEntry;

  const entryWithOverlay = {
    ...entryWithoutOverlay,
    model_overlay: COMPLETE_OVERLAY,
  } satisfies StaticModelMetadataEntry;

  expect(entryWithoutOverlay).not.toHaveProperty('model_overlay');
  expect(entryWithOverlay.model_overlay).toEqual(COMPLETE_OVERLAY);
  expectTypeOf<StaticModelMetadataEntry['model_overlay']>().toEqualTypeOf<
    ModelOverlay | undefined
  >();
});

test('model overlay type requires all four documented fields', () => {
  expectTypeOf(COMPLETE_OVERLAY).toMatchTypeOf<ModelOverlay>();

  // @ts-expect-error ModelOverlay requires narrate_only_retry when present.
  const incompleteOverlay: ModelOverlay = {
    tool_discipline: 'use tools deliberately',
    completion_contract: 'finish cleanly',
    execution_policy: 'execute only approved actions',
  };

  expect(incompleteOverlay).not.toHaveProperty('narrate_only_retry');
});

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

test('future family matcher skeletons are inert', () => {
  expect(isCodexFamilyModelId('gpt-5-codex')).toBe(false);
  expect(isLocalLlmModelId('ollama/qwen3')).toBe(false);
});

test.each(
  listStaticModelMetadataModelIds(),
)('getModelOverlay returns undefined for current catalog entry %s', (modelId) => {
  expect(getModelOverlay(modelId)).toBeUndefined();
});

test('getModelOverlay returns undefined for normalized model variants', () => {
  expect(getModelOverlay('openai-codex/gpt-5')).toBeUndefined();
  expect(getModelOverlay('gpt-5:latest')).toBeUndefined();
  expect(getModelOverlay('openai/gpt-5:latest')).toBeUndefined();
});
