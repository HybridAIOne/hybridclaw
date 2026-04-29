import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { judgeTrace } from '../src/evals/trace-judge.js';
import { getSessionUsageTotals, initDatabase } from '../src/memory/db.js';

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-judge-'));
  return path.join(dir, 'test.db');
}

test('judgeTrace falls back when the cheapest model call fails', async () => {
  const calls: string[] = [];
  const result = await judgeTrace(
    { steps: [{ action: 'used-memory', output: 'correct' }] },
    'Pass when the trace uses memory and produces the correct answer.',
    {
      model: 'cheap-json-model',
      fallbackModels: ['fallback-json-model'],
      refreshCatalog: false,
      modelCaller: vi.fn(async ({ model }) => {
        calls.push(model);
        if (model === 'cheap-json-model') {
          throw new Error('rate limited');
        }
        return {
          content: JSON.stringify({
            score: 0.9,
            reasoning: 'The trace used memory and reached the expected answer.',
            verdict: 'pass',
          }),
        };
      }),
    },
  );

  expect(calls).toEqual(['cheap-json-model', 'fallback-json-model']);
  expect(result).toEqual({
    score: 0.9,
    reasoning: 'The trace used memory and reached the expected answer.',
    verdict: 'pass',
  });
});

test('judgeTrace records judge usage cost into UsageTotals', async () => {
  const dbPath = createTempDbPath();
  initDatabase({ quiet: true, dbPath });

  await judgeTrace({ answer: 'A' }, 'Pass correct answers.', {
    model: 'cheap-json-model',
    refreshCatalog: false,
    usageContext: {
      sessionId: 'judge-session',
      agentId: 'judge-agent',
      timestamp: '2026-04-29T00:00:00.000Z',
    },
    modelCaller: vi.fn(async () => ({
      content: JSON.stringify({
        score: 0.8,
        reasoning: 'The answer satisfies the criterion.',
        verdict: 'pass',
      }),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        costUsd: 0.0012,
      },
    })),
  });

  const totals = getSessionUsageTotals('judge-session');
  expect(totals).toMatchObject({
    total_input_tokens: 100,
    total_output_tokens: 20,
    total_tokens: 120,
    total_cost_usd: 0.0012,
    cost_per_call_usd: 0.0012,
    call_count: 1,
  });
});
