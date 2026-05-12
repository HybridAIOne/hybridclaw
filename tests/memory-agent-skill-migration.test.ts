import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

let tempDir: string | null = null;
const ORIGINAL_HOME = process.env.HOME;

afterEach(() => {
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function createV21SkillObservationDatabase(dbPath: string): void {
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE skill_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial')),
      error_category TEXT,
      error_detail TEXT,
      tool_calls_attempted INTEGER NOT NULL DEFAULT 0,
      tool_calls_failed INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      user_feedback TEXT,
      feedback_sentiment TEXT CHECK (
        feedback_sentiment IS NULL OR
        feedback_sentiment IN ('positive', 'negative', 'neutral')
      ),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  database.pragma('user_version = 21');
  const insert = database.prepare(`
    INSERT INTO skill_observations (
      skill_name,
      session_id,
      run_id,
      agent_id,
      outcome,
      tool_calls_attempted,
      tool_calls_failed,
      duration_ms,
      feedback_sentiment,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 10; index += 1) {
    insert.run(
      'demo-skill',
      `session-high-${index}`,
      `run-high-${index}`,
      'high',
      'success',
      1,
      0,
      100,
      index === 0 ? 'positive' : null,
      `2026-04-27T10:00:${String(index).padStart(2, '0')}.000Z`,
    );
  }
  insert.run(
    'demo-skill',
    'session-low',
    'run-low',
    'low',
    'failure',
    1,
    1,
    100,
    null,
    '2026-04-27T11:00:00.000Z',
  );
  database.close();
}

test('agent skill score migration backfills quality scores', async () => {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-score-migration-'),
  );
  process.env.HOME = tempDir;
  const dbPath = path.join(tempDir, 'hybridclaw.db');
  createV21SkillObservationDatabase(dbPath);

  const { getAgentSkillScores, initDatabase } = await import(
    '../src/memory/db.ts'
  );
  initDatabase({ quiet: true, dbPath });

  const database = new Database(dbPath);
  const storedScores = database
    .prepare(
      `SELECT agent_id, quality_score
       FROM agent_skill_scores
       ORDER BY agent_id ASC`,
    )
    .all() as Array<{ agent_id: string; quality_score: number | null }>;
  database.close();

  expect(storedScores).toEqual([
    { agent_id: 'high', quality_score: expect.any(Number) },
    { agent_id: 'low', quality_score: expect.any(Number) },
  ]);
  expect(storedScores.every((score) => score.quality_score != null)).toBe(true);
  expect(getAgentSkillScores({ skillName: 'demo-skill', limit: 1 })).toEqual([
    expect.objectContaining({
      agent_id: 'high',
      quality_score: expect.any(Number),
    }),
  ]);
});
