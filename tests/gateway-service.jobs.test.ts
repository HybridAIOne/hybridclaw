import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-jobs-'));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin jobs support create, move, archive, and terminal board rendering', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const {
    createGatewayAdminJob,
    getGatewayAdminJobHistory,
    getGatewayAdminJobs,
    handleGatewayCommand,
    updateGatewayAdminJob,
  } = await import('../src/gateway/gateway-service.ts');

  initDatabase({ quiet: true });
  memoryService.getOrCreateSession('session-jobs', null, 'web');

  const created = createGatewayAdminJob({
    job: {
      title: 'Polish onboarding copy',
      details: 'Tighten the first-run flow',
      status: 'backlog',
      priority: 'high',
      sourceSessionId: 'session-jobs',
    },
    actorKind: 'user',
    actorId: 'alice',
  });

  expect(created.jobs).toHaveLength(1);
  const createdJob = created.jobs[0];
  expect(createdJob).toMatchObject({
    title: 'Polish onboarding copy',
    status: 'backlog',
    priority: 'high',
    sourceSessionId: 'session-jobs',
  });

  const board = await handleGatewayCommand({
    sessionId: 'session-jobs',
    guildId: null,
    channelId: 'web',
    args: ['job', 'board'],
    userId: 'alice',
    username: 'alice',
  });

  expect(board.kind).toBe('info');
  if (board.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${board.kind}`);
  }
  expect(board.preformatted).toBe(true);
  expect(board.text).toContain('Backlog (1)');
  expect(board.text).toContain(`  #${createdJob.id} Polish onboarding copy`);
  expect(board.text).toContain(
    '    HIGH · No agent assigned · session session-jobs',
  );
  expect(board.text).toContain(`#${createdJob.id} Polish onboarding copy`);
  expect(board.text).not.toContain('│');

  const inspect = await handleGatewayCommand({
    sessionId: 'session-jobs',
    guildId: null,
    channelId: 'web',
    args: ['job', 'edit', String(createdJob.id)],
    userId: 'alice',
    username: 'alice',
  });

  expect(inspect.kind).toBe('info');
  if (inspect.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${inspect.kind}`);
  }
  expect(inspect.title).toBe(`Job #${createdJob.id}`);
  expect(inspect.text).toContain('Title: Polish onboarding copy');

  const started = await handleGatewayCommand({
    sessionId: 'session-jobs',
    guildId: null,
    channelId: 'web',
    args: ['job', 'start', String(createdJob.id)],
    userId: 'alice',
    username: 'alice',
  });

  expect(started.kind).toBe('plain');
  if (started.kind !== 'plain') {
    throw new Error(`Unexpected result kind: ${started.kind}`);
  }
  expect(started.text).toContain(`Job #${createdJob.id} started.`);

  const afterMove = getGatewayAdminJobs();
  expect(afterMove.jobs.find((job) => job.id === createdJob.id)).toMatchObject({
    status: 'in_progress',
    lanePosition: 0,
    dispatch: {
      phase: 'unassigned',
      label: 'unassigned',
      summary: 'No agent assigned',
    },
  });

  updateGatewayAdminJob({
    jobId: createdJob.id,
    patch: { archived: true },
    actorKind: 'user',
    actorId: 'alice',
  });

  expect(
    getGatewayAdminJobs().jobs.find((job) => job.id === createdJob.id),
  ).toBeUndefined();
  expect(
    getGatewayAdminJobs({ includeArchived: true }).jobs.find(
      (job) => job.id === createdJob.id,
    )?.archivedAt,
  ).toBeTruthy();

  const history = getGatewayAdminJobHistory(createdJob.id);
  expect(history.job?.id).toBe(createdJob.id);
  expect(history.events.map((event) => event.action)).toEqual(
    expect.arrayContaining(['created', 'moved', 'archived']),
  );
});
