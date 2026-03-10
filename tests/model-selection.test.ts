import { expect, test } from 'vitest';

import {
  normalizeModelCandidates,
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
