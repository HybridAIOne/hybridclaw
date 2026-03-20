import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-side-effects-jobs-'),
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('processSideEffects applies agent job creates and moves', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { processSideEffects } = await import('../src/agent/side-effects.ts');
  const { getAgentJobById, initDatabase, listAgentJobs } = await import(
    '../src/memory/db.ts'
  );

  initDatabase({ quiet: true });

  processSideEffects(
    {
      status: 'success',
      result: null,
      toolsUsed: [],
      sideEffects: {
        jobs: [
          {
            action: 'create',
            title: 'Implement terminal board',
            details: 'Add the kanban board to the TUI',
            status: 'ready',
            priority: 'high',
          },
        ],
      },
    },
    'session-jobs',
    'web',
    {
      actorKind: 'agent',
      actorId: 'main',
    },
  );

  const [createdJob] = listAgentJobs();
  expect(createdJob).toMatchObject({
    title: 'Implement terminal board',
    status: 'ready',
    priority: 'high',
    created_by_kind: 'agent',
    created_by_id: 'main',
    source_session_id: 'session-jobs',
  });

  processSideEffects(
    {
      status: 'success',
      result: null,
      toolsUsed: [],
      sideEffects: {
        jobs: [
          {
            action: 'move',
            jobId: createdJob.id,
            status: 'done',
            position: 0,
          },
        ],
      },
    },
    'session-jobs',
    'web',
    {
      actorKind: 'agent',
      actorId: 'main',
    },
  );

  expect(getAgentJobById(createdJob.id)).toMatchObject({
    status: 'done',
    lane_position: 0,
  });
});
