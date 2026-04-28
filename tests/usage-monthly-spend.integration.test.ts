import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import {
  getUsageTotals,
  initDatabase,
  listUsageByAgent,
  monthlySpend,
  recordUsageEvent,
} from '../src/memory/db.js';

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-usage-'));
  return path.join(dir, 'test.db');
}

function previousMonthIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12),
  ).toISOString();
}

test('monthlySpend matches the monthly UsageTotals rollup per coworker', () => {
  initDatabase({ quiet: true, dbPath: createTempDbPath() });

  recordUsageEvent({
    sessionId: 'session-alpha-1',
    agentId: 'alpha',
    model: 'gpt-5-mini',
    inputTokens: 100,
    outputTokens: 40,
    costUsd: 0.25,
  });
  recordUsageEvent({
    sessionId: 'session-alpha-2',
    agentId: 'alpha',
    model: 'gpt-5-mini',
    inputTokens: 80,
    outputTokens: 20,
    costUsd: 0.1,
  });
  recordUsageEvent({
    sessionId: 'session-beta-1',
    agentId: 'beta',
    model: 'gpt-5-nano',
    inputTokens: 50,
    outputTokens: 10,
    costUsd: 0.04,
  });
  recordUsageEvent({
    sessionId: 'session-alpha-old',
    agentId: 'alpha',
    model: 'gpt-5-mini',
    inputTokens: 1_000,
    outputTokens: 1_000,
    costUsd: 10,
    timestamp: previousMonthIso(),
  });

  const alphaTotals = getUsageTotals({
    agentId: 'alpha',
    window: 'monthly',
  });
  const monthlyRows = new Map(
    listUsageByAgent({ window: 'monthly' }).map(
      (row) => [row.agent_id, row] as const,
    ),
  );

  expect(alphaTotals.total_cost_usd).toBeCloseTo(0.35, 6);
  expect(monthlySpend('alpha')).toBeCloseTo(alphaTotals.total_cost_usd, 6);
  expect(monthlyRows.get('alpha')?.total_cost_usd).toBeCloseTo(0.35, 6);
  expect(monthlyRows.get('beta')?.total_cost_usd).toBeCloseTo(0.04, 6);
});
