import { expect, test } from 'vitest';

import {
  normalizeModelCandidates,
  parseModelInfoSummaryFromText,
  parseModelNamesFromListText,
} from '../src/model-selection.js';

test('normalizeModelCandidates trims and deduplicates model names', () => {
  expect(
    normalizeModelCandidates([
      ' gpt-5-nano ',
      '',
      'lmstudio/qwen/qwen3.5-9b',
      'gpt-5-nano',
    ]),
  ).toEqual(['gpt-5-nano', 'lmstudio/qwen/qwen3.5-9b']);
});

test('parseModelNamesFromListText strips current markers from gateway list output', () => {
  expect(
    parseModelNamesFromListText(
      [
        'gpt-5-nano',
        'lmstudio/qwen/qwen3.5-9b (current)',
        'openai-codex/gpt-5-codex',
      ].join('\n'),
    ),
  ).toEqual([
    'gpt-5-nano',
    'lmstudio/qwen/qwen3.5-9b',
    'openai-codex/gpt-5-codex',
  ]);
});

test('parseModelInfoSummaryFromText parses legacy current/default output', () => {
  expect(
    parseModelInfoSummaryFromText(
      [
        'Current model: openrouter/hunter-alpha',
        'Default model: openrouter/anthropic/claude-sonnet-4',
      ].join('\n'),
    ),
  ).toEqual({
    current: 'openrouter/hunter-alpha',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4',
  });
});

test('parseModelInfoSummaryFromText parses effective/session override output', () => {
  expect(
    parseModelInfoSummaryFromText(
      [
        'Effective model: openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        'Session override: openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        'Agent model: (inherits global default)',
        'Global default: openrouter/anthropic/claude-sonnet-4',
      ].join('\n'),
    ),
  ).toEqual({
    current: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4',
  });
});

test('parseModelInfoSummaryFromText parses scoped global/agent/session output', () => {
  expect(
    parseModelInfoSummaryFromText(
      [
        'Global model: openrouter/anthropic/claude-sonnet-4',
        'Agent model: openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        'Session model: (none)',
      ].join('\n'),
    ),
  ).toEqual({
    current: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4',
  });
});
