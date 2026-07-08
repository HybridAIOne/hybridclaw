import path from 'node:path';

import { expect, test } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempHome = useTempDir('hybridclaw-delegation-jobs-');
const ORIGINAL_HOME = process.env.HOME;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  resetModules: true,
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
});

async function importFreshDb(homeDir: string) {
  process.env.HOME = homeDir;
  const db = await import('../src/memory/db.js');
  db.initDatabase({
    quiet: true,
    dbPath: path.join(homeDir, 'hybridclaw.db'),
  });
  return db;
}

test('delegation job accessors track lifecycle and artifacts', async () => {
  const db = await importFreshDb(makeTempHome());

  db.createDelegationJob({
    publicId: 'chatcmpl_lifecycle',
    internalId: 'parent:1:internal',
    parentSessionId: 'parent-session',
    channelId: 'openai',
    agentId: 'main',
    model: 'gpt-5',
    taskCount: 2,
    ackText: 'Started 2 delegate jobs.',
  });
  expect(db.getDelegationJob('chatcmpl_lifecycle')).toMatchObject({
    public_id: 'chatcmpl_lifecycle',
    status: 'queued',
    task_count: 2,
    ack_text: 'Started 2 delegate jobs.',
  });

  db.markDelegationJobInProgress('chatcmpl_lifecycle');
  expect(db.getDelegationJob('chatcmpl_lifecycle')).toMatchObject({
    status: 'in_progress',
    started_at: expect.any(String),
  });

  db.completeDelegationJob('chatcmpl_lifecycle', {
    resultText: 'Final synthesized answer.',
    resultDigest: 'Internal digest.',
    artifacts: [
      {
        path: '/tmp/report.md',
        filename: 'report.md',
        mimeType: 'text/markdown',
      },
    ],
  });
  const completed = db.getDelegationJob('chatcmpl_lifecycle');
  expect(completed).toMatchObject({
    status: 'completed',
    result_text: 'Final synthesized answer.',
    result_digest: 'Internal digest.',
    error: null,
    completed_at: expect.any(String),
  });
  expect(JSON.parse(completed?.artifacts_json || '[]')).toEqual([
    {
      path: '/tmp/report.md',
      filename: 'report.md',
      mimeType: 'text/markdown',
    },
  ]);
});

test('delegation job cancellation and stale failure only affect active rows', async () => {
  const db = await importFreshDb(makeTempHome());

  db.createDelegationJob({
    publicId: 'chatcmpl_cancel',
    internalId: 'parent:cancel',
    parentSessionId: 'parent-session',
    channelId: 'openai',
    agentId: 'main',
    taskCount: 1,
  });
  expect(db.cancelDelegationJob('chatcmpl_cancel')).toBe(true);
  expect(db.getDelegationJob('chatcmpl_cancel')?.status).toBe('cancelled');

  db.createDelegationJob({
    publicId: 'chatcmpl_running',
    internalId: 'parent:running',
    parentSessionId: 'parent-session',
    channelId: 'openai',
    agentId: 'main',
    taskCount: 1,
  });
  db.markDelegationJobInProgress('chatcmpl_running');
  expect(db.cancelDelegationJob('chatcmpl_running')).toBe(false);
  expect(db.getDelegationJob('chatcmpl_running')?.status).toBe('in_progress');

  db.createDelegationJob({
    publicId: 'chatcmpl_queued',
    internalId: 'parent:queued',
    parentSessionId: 'parent-session',
    channelId: 'openai',
    agentId: 'main',
    taskCount: 1,
  });
  expect(db.failStaleDelegationJobs('gateway_restart')).toBe(2);
  expect(db.getDelegationJob('chatcmpl_cancel')?.status).toBe('cancelled');
  expect(db.getDelegationJob('chatcmpl_running')).toMatchObject({
    status: 'failed',
    error: 'gateway_restart',
  });
  expect(db.getDelegationJob('chatcmpl_queued')).toMatchObject({
    status: 'failed',
    error: 'gateway_restart',
  });
});

test('delegation job pruning removes old terminal rows and preserves active rows', async () => {
  const db = await importFreshDb(makeTempHome());

  for (const id of ['old_completed', 'new_completed', 'active_queued']) {
    db.createDelegationJob({
      publicId: `chatcmpl_${id}`,
      internalId: `parent:${id}`,
      parentSessionId: 'parent-session',
      channelId: 'openai',
      agentId: 'main',
      taskCount: 1,
    });
  }
  db.completeDelegationJob('chatcmpl_old_completed', {
    resultText: 'old',
    resultDigest: 'old digest',
  });
  db.completeDelegationJob('chatcmpl_new_completed', {
    resultText: 'new',
    resultDigest: 'new digest',
  });
  db.withMemoryDatabase((database) => {
    database
      .prepare(
        "UPDATE delegation_jobs SET created_at = datetime('now', '-10 days') WHERE public_id = ?",
      )
      .run('chatcmpl_old_completed');
  });

  db.pruneDelegationJobs({ retentionDays: 7, maxRows: 1 });
  expect(db.getDelegationJob('chatcmpl_old_completed')).toBeNull();
  expect(db.getDelegationJob('chatcmpl_new_completed')?.status).toBe(
    'completed',
  );
  expect(db.getDelegationJob('chatcmpl_active_queued')?.status).toBe('queued');
});
