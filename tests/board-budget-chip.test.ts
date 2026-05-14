import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmpDir: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;

async function loadBudgetContext() {
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  vi.resetModules();
  const dbModule = await import('../src/memory/db.js');
  const boardModule = await import('../src/board/card-store.js');
  const budgetModule = await import('../src/board/budget-chip.js');
  const runtimeConfig = await import('../src/config/runtime-config.js');
  const eventsModule = await import('../src/skills/skill-run-events.js');
  const metadata = await import('../src/providers/model-metadata.js');
  dbModule.initDatabase({
    quiet: true,
    dbPath: path.join(tmpDir, 'data', 'hybridclaw.db'),
  });
  return {
    dbModule,
    boardModule,
    budgetModule,
    runtimeConfig,
    eventsModule,
    metadata,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-budget-chip-'));
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.sequential('board budget chips', () => {
  test('summarizes configured card-owner budgets and emits soft warn once per window', async () => {
    const {
      dbModule,
      boardModule,
      budgetModule,
      runtimeConfig,
      eventsModule,
      metadata,
    } = await loadBudgetContext();
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'under', budget: { cap: 60, currency: 'USD' } },
        { id: 'warn', budget: { cap: 100, currency: 'USD' } },
        { id: 'hard', budget: { cap: 10, currency: 'EUR' } },
        { id: 'none' },
      ];
    });
    boardModule.createCard({
      id: 'card-under',
      title: 'Under budget',
      owner: { agentId: 'under' },
    });
    boardModule.createCard({
      id: 'card-warn',
      title: 'Warn budget',
      owner: { agentId: 'warn' },
    });
    boardModule.createCard({
      id: 'card-hard',
      title: 'Hard budget',
      owner: { agentId: 'hard' },
    });
    boardModule.createCard({
      id: 'card-none',
      title: 'No budget',
      owner: { agentId: 'none' },
    });
    dbModule.recordUsageEvent({
      sessionId: 'session-under',
      agentId: 'under',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 3.4,
    });
    dbModule.recordUsageEvent({
      sessionId: 'session-warn',
      agentId: 'warn',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 81,
    });
    dbModule.recordUsageEvent({
      sessionId: 'session-hard',
      agentId: 'hard',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 12 * metadata.MODEL_METADATA_USD_TO_EUR.usdPerEur,
    });

    const events: unknown[] = [];
    const unsubscribe = eventsModule.subscribeRuntimeEvents((event) => {
      events.push(event);
    });

    const first = budgetModule.getBoardBudgetSummaries({
      now: new Date('2026-05-14T12:00:00.000Z'),
    });
    const second = budgetModule.getBoardBudgetSummaries({
      now: new Date('2026-05-14T12:05:00.000Z'),
    });
    unsubscribe();

    expect(first.budgets).toEqual([
      expect.objectContaining({
        agentId: 'hard',
        cap: 10,
        currency: 'EUR',
        percent: 120,
      }),
      expect.objectContaining({
        agentId: 'under',
        used: 3.4,
        cap: 60,
        currency: 'USD',
      }),
      expect.objectContaining({
        agentId: 'warn',
        used: 81,
        cap: 100,
        currency: 'USD',
        percent: 81,
      }),
    ]);
    expect(first.budgets.some((budget) => budget.agentId === 'none')).toBe(
      false,
    );
    expect(second.budgets).toHaveLength(3);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'budget.soft_warn',
        agent_id: 'hard',
        billing_window: '2026-05',
        percent: 120,
      }),
      expect.objectContaining({
        type: 'budget.soft_warn',
        agent_id: 'warn',
        billing_window: '2026-05',
        percent: 81,
      }),
    ]);
  });
});
