import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-workflow-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'hybridclaw.db');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('workflow CRUD and companion task lookup work against the database', async () => {
  const dbPath = makeTempDbPath();
  process.env.HOME = path.dirname(dbPath);
  const dbModule = await import('../../../src/memory/db.ts');

  dbModule.initDatabase({ quiet: true, dbPath });

  const companionTaskId = dbModule.createTask(
    'session-1',
    '123456789012345678',
    '0 9 * * *',
    'Workflow: Daily digest',
  );
  const workflowId = dbModule.createWorkflow({
    sessionId: 'session-1',
    agentId: 'agent-1',
    channelId: '123456789012345678',
    name: 'Daily digest',
    description: 'Summarize recent messages every morning.',
    naturalLanguage:
      'Every day at 9am, summarize my recent Discord messages and email me.',
    companionTaskId,
    spec: {
      version: 2,
      trigger: {
        kind: 'schedule',
        cronExpr: '0 9 * * *',
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the latest Discord messages.',
        },
      ],
      delivery: {
        kind: 'email',
        target: 'me@example.com',
      },
    },
  });

  expect(dbModule.getWorkflow(workflowId)).toMatchObject({
    id: workflowId,
    session_id: 'session-1',
    companion_task_id: companionTaskId,
    name: 'Daily digest',
  });
  expect(dbModule.getWorkflowByCompanionTaskId(companionTaskId)?.id).toBe(
    workflowId,
  );
  expect(
    dbModule
      .listWorkflows({ sessionId: 'session-1' })
      .map((workflow) => workflow.id),
  ).toContain(workflowId);

  dbModule.updateWorkflow(workflowId, {
    description: 'Updated description',
    enabled: false,
  });
  dbModule.updateWorkflowRunStatus(workflowId, 'partial');

  expect(dbModule.getWorkflow(workflowId)).toMatchObject({
    description: 'Updated description',
    enabled: 0,
    last_status: 'partial',
    run_count: 1,
    consecutive_errors: 0,
  });

  dbModule.deleteWorkflow(workflowId);
  expect(dbModule.getWorkflow(workflowId)).toBeNull();
});

test('migrates a v10 database forward to add the workflows table', async () => {
  const dbPath = makeTempDbPath();
  process.env.HOME = path.dirname(dbPath);
  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
  `);
  rawDb.pragma('user_version = 10');
  rawDb.close();

  const dbModule = await import('../../../src/memory/db.ts');
  dbModule.initDatabase({ quiet: true, dbPath });

  const verifyDb = new Database(dbPath, { readonly: true });
  const workflowTable = verifyDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflows'",
    )
    .get() as { name: string } | undefined;
  const schemaVersion = verifyDb.pragma('user_version', {
    simple: true,
  }) as number;
  verifyDb.close();

  expect(workflowTable?.name).toBe('workflows');
  expect(schemaVersion).toBe(dbModule.DATABASE_SCHEMA_VERSION);
});
