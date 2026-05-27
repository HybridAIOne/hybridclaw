import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmpDir: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;

const FIXED_NOW = new Date('2026-05-14T12:00:00.000Z');
const FIXED_BILLING_WINDOW = '2026-05';

async function flushUsageNotifications(): Promise<void> {
  await Promise.resolve();
}

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
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDataDir === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.sequential('board budget chips', () => {
  test('preserves fallback for invalid budget config values', async () => {
    const { normalizeAgentBudgetConfig } = await import(
      '../src/agents/agent-types.js'
    );

    expect(
      normalizeAgentBudgetConfig(42, { cap: 10, currency: 'USD', unit: 'USD' }),
    ).toEqual({ cap: 10, currency: 'USD', unit: 'USD' });
    expect(
      normalizeAgentBudgetConfig(undefined, {
        cap: 10,
        currency: 'USD',
        unit: 'USD',
      }),
    ).toEqual({ cap: 10, currency: 'USD', unit: 'USD' });
    expect(
      normalizeAgentBudgetConfig({ cap: '100000', unit: 'tokens' }),
    ).toEqual({ cap: 100000, currency: 'USD', unit: 'tokens' });
    expect(
      normalizeAgentBudgetConfig({ cap: '1000.9', unit: 'tokens' }),
    ).toEqual({ cap: 1000, currency: 'USD', unit: 'tokens' });
    expect(normalizeAgentBudgetConfig({ cap: '0.5', unit: 'tokens' })).toBe(
      undefined,
    );
    expect(normalizeAgentBudgetConfig({ cap: 25, currency: 'EUR' })).toEqual({
      cap: 25,
      currency: 'EUR',
      unit: 'EUR',
    });
  });

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
        { id: 'under', budget: { cap: 60, currency: 'USD', unit: 'USD' } },
        { id: 'warn', budget: { cap: 100, currency: 'USD', unit: 'USD' } },
        { id: 'hard', budget: { cap: 10, currency: 'EUR', unit: 'EUR' } },
        {
          id: 'token-warn',
          budget: { cap: 100_000, currency: 'USD', unit: 'tokens' },
        },
        { id: 'done-owner', budget: { cap: 1, currency: 'USD', unit: 'USD' } },
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
      id: 'card-token-warn',
      title: 'Token warn budget',
      owner: { agentId: 'token-warn' },
    });
    boardModule.createCard({
      id: 'card-none',
      title: 'No budget',
      owner: { agentId: 'none' },
    });
    boardModule.createCard({
      id: 'card-done',
      title: 'Done card',
      owner: { agentId: 'done-owner' },
      column: 'done',
    });

    const events: unknown[] = [];
    const unsubscribe = eventsModule.subscribeRuntimeEvents((event) => {
      events.push(event);
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
    dbModule.recordUsageEvent({
      sessionId: 'session-token-warn',
      agentId: 'token-warn',
      model: 'gpt-5',
      inputTokens: 60_000,
      outputTokens: 20_000,
      totalTokens: 80_000,
      costUsd: 0,
    });
    dbModule.recordUsageEvent({
      sessionId: 'session-done',
      agentId: 'done-owner',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 2,
    });

    await flushUsageNotifications();

    const billingWindow = FIXED_BILLING_WINDOW;
    const emittedAfterUsageWrites = events.length;
    const first = budgetModule.getBoardBudgetSummaries();
    const second = budgetModule.getBoardBudgetSummaries();
    dbModule.recordUsageEvent({
      sessionId: 'session-warn-followup',
      agentId: 'warn',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 1,
    });
    await flushUsageNotifications();
    unsubscribe();

    expect(first.budgets).toEqual([
      expect.objectContaining({
        agentId: 'hard',
        cap: 10,
        unit: 'EUR',
        currency: 'EUR',
        percent: 120,
      }),
      expect.objectContaining({
        agentId: 'token-warn',
        used: 80_000,
        cap: 100_000,
        unit: 'tokens',
        currency: 'USD',
        percent: 80,
      }),
      expect.objectContaining({
        agentId: 'under',
        used: 3.4,
        cap: 60,
        unit: 'USD',
        currency: 'USD',
      }),
      expect.objectContaining({
        agentId: 'warn',
        used: 81,
        cap: 100,
        unit: 'USD',
        currency: 'USD',
        percent: 81,
      }),
    ]);
    expect(first.budgets.some((budget) => budget.agentId === 'none')).toBe(
      false,
    );
    expect(
      first.budgets.some((budget) => budget.agentId === 'done-owner'),
    ).toBe(false);
    expect(second.budgets).toHaveLength(4);
    expect(emittedAfterUsageWrites).toBe(4);
    expect(events).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'budget.soft_warn',
          agent_id: 'hard',
          billing_window: billingWindow,
          percent: 120,
        }),
        expect.objectContaining({
          type: 'budget.soft_warn',
          agent_id: 'token-warn',
          billing_window: billingWindow,
          unit: 'tokens',
          percent: 80,
        }),
        expect.objectContaining({
          type: 'budget.soft_warn',
          agent_id: 'done-owner',
          billing_window: billingWindow,
          percent: 200,
        }),
        expect.objectContaining({
          type: 'budget.soft_warn',
          agent_id: 'warn',
          billing_window: billingWindow,
          percent: 81,
        }),
      ]),
    );

    const database = new Database(path.join(tmpDir, 'data', 'hybridclaw.db'), {
      readonly: true,
    });
    try {
      const marker = database
        .prepare(
          `SELECT unit, currency
           FROM budget_soft_warn_events
           WHERE agent_id = ? AND billing_window = ?`,
        )
        .get('token-warn', billingWindow);
      expect(marker).toEqual({ unit: 'tokens', currency: 'USD' });
    } finally {
      database.close();
    }
  });

  test('migrates budget soft-warn units into the marker key', async () => {
    process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
    process.env.HOME = tmpDir;
    const dbPath = path.join(tmpDir, 'data', 'hybridclaw.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const oldDatabase = new Database(dbPath);
    try {
      oldDatabase.exec(`
        CREATE TABLE budget_soft_warn_events (
          agent_id TEXT NOT NULL,
          billing_window TEXT NOT NULL,
          emitted_at TEXT NOT NULL,
          used REAL NOT NULL,
          cap REAL NOT NULL,
          currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
          percent REAL NOT NULL,
          PRIMARY KEY (agent_id, billing_window)
        );
        INSERT INTO budget_soft_warn_events
          (agent_id, billing_window, emitted_at, used, cap, currency, percent)
        VALUES
          ('eur-agent', '2026-05', '2026-05-14T12:00:00.000Z', 8, 10, 'EUR', 80);
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('scheduler_job', 'scheduled_task')),
          legacy_task_id INTEGER UNIQUE,
          session_id TEXT,
          channel_id TEXT,
          name TEXT,
          description TEXT,
          agent_id TEXT,
          board_status TEXT CHECK (board_status IS NULL OR board_status IN ('backlog', 'in_progress', 'review', 'done', 'cancelled')),
          max_retries INTEGER,
          schedule TEXT NOT NULL,
          action TEXT NOT NULL,
          delivery TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run TEXT,
          last_status TEXT CHECK (last_status IS NULL OR last_status IN ('success', 'error')),
          consecutive_errors INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        PRAGMA user_version = 37;
      `);
    } finally {
      oldDatabase.close();
    }

    vi.resetModules();
    const dbModule = await import('../src/memory/db.js');
    dbModule.initDatabase({ quiet: true, dbPath });

    const migratedDatabase = new Database(dbPath);
    try {
      const table = migratedDatabase
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'budget_soft_warn_events'",
        )
        .get() as { sql: string };
      expect(table.sql).toContain("CHECK (unit IN ('USD', 'EUR', 'tokens'))");
      expect(table.sql).toContain(
        'PRIMARY KEY (agent_id, billing_window, unit)',
      );
      expect(
        migratedDatabase
          .prepare(
            'SELECT unit, currency FROM budget_soft_warn_events WHERE agent_id = ?',
          )
          .get('eur-agent'),
      ).toEqual({ unit: 'EUR', currency: 'EUR' });
      expect(() => {
        migratedDatabase
          .prepare(
            `INSERT INTO budget_soft_warn_events
              (agent_id, billing_window, emitted_at, used, cap, unit, currency, percent)
             VALUES
              ('bad-agent', '2026-05', '2026-05-14T12:00:00.000Z', 1, 10, 'credits', 'USD', 10)`,
          )
          .run();
      }).toThrow();
      expect(() => {
        migratedDatabase
          .prepare(
            `INSERT INTO budget_soft_warn_events
              (agent_id, billing_window, emitted_at, used, cap, unit, currency, percent)
             VALUES
              ('eur-agent', '2026-05', '2026-05-14T12:00:00.000Z', 1000, 1000, 'tokens', 'USD', 100)`,
          )
          .run();
      }).not.toThrow();
    } finally {
      migratedDatabase.close();
    }
  });
});
