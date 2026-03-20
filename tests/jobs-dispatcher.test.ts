import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-job-dispatch-'),
  );
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

afterEach(async () => {
  try {
    const { stopJobDispatcher } = await import('../src/jobs/dispatcher.ts');
    stopJobDispatcher();
  } catch {
    // ignore module reload failures during cleanup
  }
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatcher automatically starts and completes ready jobs with an assignee', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, createAgentJob, getAgentJobById, listAgentJobEvents } =
    await import('../src/memory/db.ts');
  const { configureJobDispatcherRuntime, dispatchReadyAgentJobsOnce } =
    await import('../src/jobs/dispatcher.ts');

  initDatabase({ quiet: true });
  const job = createAgentJob({
    title: 'Ship the release notes',
    details: 'Draft and publish the release summary',
    status: 'ready',
    priority: 'high',
    assigneeAgentId: 'main',
    createdByKind: 'user',
    createdById: 'alice',
    sourceSessionId: 'session-release',
  });

  const handleGatewayMessage = vi.fn(async () => ({
    status: 'success' as const,
    result: 'Release notes are done.',
  }));
  configureJobDispatcherRuntime({ handleGatewayMessage });

  await dispatchReadyAgentJobsOnce();

  expect(handleGatewayMessage).toHaveBeenCalledTimes(1);
  expect(handleGatewayMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: 'main',
      channelId: 'scheduler',
      source: 'scheduler',
      sessionId: 'agent:main:channel:scheduler:chat:job:peer:job-1',
    }),
  );
  expect(getAgentJobById(job.id)).toMatchObject({
    status: 'done',
    assignee_agent_id: 'main',
  });
  expect(listAgentJobEvents(job.id).map((event) => event.action)).toEqual(
    expect.arrayContaining([
      'created',
      'moved',
      'dispatch_started',
      'dispatch_succeeded',
    ]),
  );
});

test('dispatcher picks up assigned in-progress jobs that have not started yet', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, createAgentJob, getAgentJobById } = await import(
    '../src/memory/db.ts'
  );
  const { configureJobDispatcherRuntime, dispatchReadyAgentJobsOnce } =
    await import('../src/jobs/dispatcher.ts');

  initDatabase({ quiet: true });
  const job = createAgentJob({
    title: 'Brainstorm features',
    status: 'in_progress',
    assigneeAgentId: 'main',
    createdByKind: 'user',
    createdById: 'alice',
  });

  const handleGatewayMessage = vi.fn(async () => ({
    status: 'success' as const,
    result: 'Here are ten feature ideas.',
  }));
  configureJobDispatcherRuntime({
    handleGatewayMessage,
  });

  await dispatchReadyAgentJobsOnce();

  expect(handleGatewayMessage).toHaveBeenCalledTimes(1);
  expect(getAgentJobById(job.id)).toMatchObject({
    status: 'done',
  });
});

test('dispatcher retries failed in-progress jobs before blocking them', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, createAgentJob, getAgentJobById, listAgentJobEvents } =
    await import('../src/memory/db.ts');
  const { configureJobDispatcherRuntime, dispatchReadyAgentJobsOnce } =
    await import('../src/jobs/dispatcher.ts');

  initDatabase({ quiet: true });
  const job = createAgentJob({
    title: 'Run the migration',
    status: 'ready',
    assigneeAgentId: 'main',
    createdByKind: 'user',
    createdById: 'alice',
  });

  configureJobDispatcherRuntime({
    handleGatewayMessage: vi.fn(async () => ({
      status: 'error',
      result: null,
      error: 'Container failed to start.',
    })),
  });

  await dispatchReadyAgentJobsOnce();
  expect(getAgentJobById(job.id)).toMatchObject({
    status: 'in_progress',
  });

  await dispatchReadyAgentJobsOnce();
  expect(getAgentJobById(job.id)).toMatchObject({
    status: 'in_progress',
  });

  await dispatchReadyAgentJobsOnce();
  expect(getAgentJobById(job.id)).toMatchObject({
    status: 'blocked',
  });
  expect(
    listAgentJobEvents(job.id).filter(
      (event) => event.action === 'dispatch_failed',
    ),
  ).toHaveLength(3);
});

test('dispatcher does not overwrite a manual status change made during the run', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, createAgentJob, getAgentJobById, moveAgentJob } =
    await import('../src/memory/db.ts');
  const { configureJobDispatcherRuntime, dispatchReadyAgentJobsOnce } =
    await import('../src/jobs/dispatcher.ts');

  initDatabase({ quiet: true });
  const job = createAgentJob({
    title: 'Review onboarding flow',
    status: 'ready',
    assigneeAgentId: 'main',
    createdByKind: 'user',
    createdById: 'alice',
  });

  configureJobDispatcherRuntime({
    handleGatewayMessage: vi.fn(async () => {
      moveAgentJob({
        id: job.id,
        status: 'blocked',
        actorKind: 'user',
        actorId: 'alice',
      });
      return {
        status: 'success' as const,
        result: 'I finished the review.',
      };
    }),
  });

  await dispatchReadyAgentJobsOnce();

  expect(getAgentJobById(job.id)).toMatchObject({
    status: 'blocked',
  });
});
