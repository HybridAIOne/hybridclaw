import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { expect, expectTypeOf, test } from 'vitest';
import type { ModelOverlay } from '../src/providers/model-metadata.js';
import {
  getModelOverlay,
  isCodexFamilyModelId,
  isGpt5ModelId,
  isLocalLlmModelId,
  resolveStaticModelCatalogMetadata,
} from '../src/providers/model-metadata.js';

const COMPLETE_OVERLAY = {
  tool_discipline: 'use tools deliberately',
  completion_contract: 'return the final answer only after work is complete',
  execution_policy: 'execute only approved actions',
  narrate_only_retry: true,
} satisfies ModelOverlay;

function collectStaticModelMetadataIdsFromSource(): string[] {
  const sourcePath = path.join(
    process.cwd(),
    'src/providers/model-metadata.ts',
  );
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let modelIds: string[] | null = null;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'STATIC_MODEL_METADATA' &&
          declaration.initializer &&
          ts.isObjectLiteralExpression(declaration.initializer)
        ) {
          modelIds = declaration.initializer.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => {
              if (ts.isStringLiteralLike(property.name))
                return property.name.text;
              if (ts.isIdentifier(property.name)) return property.name.text;
              throw new Error('Unsupported static model metadata key syntax');
            });
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (!modelIds) {
    throw new Error('STATIC_MODEL_METADATA object not found');
  }
  return modelIds;
}

test('static model metadata entries accept an optional complete overlay', () => {
  type EntryWithOptionalOverlay = {
    contextWindow: number | null;
    maxTokens?: number | null;
    capabilities: {
      vision: boolean;
      tools: boolean;
      jsonMode: boolean;
      reasoning: boolean;
    };
    sources: string[];
    model_overlay?: ModelOverlay;
  };

  const entryWithoutOverlay = {
    contextWindow: 400_000,
    capabilities: {
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
    sources: ['test-source'],
  } satisfies EntryWithOptionalOverlay;

  const entryWithOverlay = {
    ...entryWithoutOverlay,
    model_overlay: COMPLETE_OVERLAY,
  } satisfies EntryWithOptionalOverlay;

  expect(entryWithoutOverlay).not.toHaveProperty('model_overlay');
  expect(entryWithOverlay.model_overlay).toEqual(COMPLETE_OVERLAY);
  expectTypeOf<EntryWithOptionalOverlay['model_overlay']>().toEqualTypeOf<
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

test.each([
  '',
  '  ',
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.5-pro',
])('isGpt5ModelId rejects non-overlay GPT-5 family input %s', (modelId) => {
  expect(isGpt5ModelId(modelId)).toBe(false);
});

test('getModelOverlay returns undefined for blank model ids', () => {
  expect(getModelOverlay('')).toBeUndefined();
  expect(getModelOverlay('  ')).toBeUndefined();
});

test('future family matcher predicates are inert skeletons', () => {
  expect(isCodexFamilyModelId('gpt-5-codex')).toBe(false);
  expect(isLocalLlmModelId('ollama/qwen3')).toBe(false);
});

test.each(
  collectStaticModelMetadataIdsFromSource(),
)('getModelOverlay returns undefined for current catalog entry %s', (modelId) => {
  expect(getModelOverlay(modelId)).toBeUndefined();
});

test('getModelOverlay returns undefined for normalized model variants', () => {
  expect(getModelOverlay('openai-codex/gpt-5')).toBeUndefined();
  expect(getModelOverlay('gpt-5:latest')).toBeUndefined();
  expect(getModelOverlay('openai/gpt-5:latest')).toBeUndefined();
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
