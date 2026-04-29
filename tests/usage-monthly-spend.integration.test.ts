import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import {
  getUsageTotals,
  initDatabase,
  listUsageByAgentRollups,
  monthlySpendEur,
  monthlySpendUsd,
  recordUsageEvent,
} from '../src/memory/db.js';
import { MODEL_METADATA_USD_TO_EUR } from '../src/providers/model-metadata.js';

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

test('monthlySpendUsd matches the monthly UsageTotals rollup per agent', () => {
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
  const rollups = new Map(
    listUsageByAgentRollups().map((row) => [row.agent_id, row] as const),
  );

  expect(alphaTotals.total_cost_usd).toBeCloseTo(0.35, 6);
  expect(monthlySpendUsd('alpha')).toBeCloseTo(alphaTotals.total_cost_usd, 6);
  expect(monthlySpendEur('alpha')).toBeCloseTo(
    alphaTotals.total_cost_usd / MODEL_METADATA_USD_TO_EUR.usdPerEur,
    6,
  );
  expect(rollups.get('alpha')?.total_cost_usd).toBeCloseTo(10.35, 6);
  expect(rollups.get('alpha')?.monthly_cost_usd).toBeCloseTo(0.35, 6);
  expect(rollups.get('beta')?.monthly_cost_usd).toBeCloseTo(0.04, 6);
});
