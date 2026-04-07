import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import { nextDateBoundaryInTimezone } from '../container/shared/workspace-time.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/infra/ipc.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/memory/memory-service.js');
});

async function loadRunner(params: {
  dataDir: string;
  mainWorkspaceDir: string;
}) {
  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: params.dataDir,
    getConfigSnapshot: vi.fn(() => ({
      memory: {
        consolidationIntervalHours: 24,
        decayRate: 0.25,
        consolidationLanguage: 'en',
      },
    })),
  }));
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: vi.fn((agentId: string) =>
      agentId === 'main' ? params.mainWorkspaceDir : params.dataDir,
    ),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      setConsolidationDecayRate: vi.fn(),
      setConsolidationLanguage: vi.fn(),
      consolidateMemoriesWithCleanup: vi.fn(async () => ({
        memoriesDecayed: 0,
        dailyFilesCompiled: 0,
        workspacesUpdated: 0,
        modelCleanups: 0,
        fallbacksUsed: 0,
        durationMs: 1,
      })),
    },
  }));
  return import('../src/gateway/memory-consolidation-runner.js');
}

test('hasDreamRunToday uses the main workspace timezone', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-dream-runner-state-'),
  );
  const mainWorkspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-dream-runner-main-'),
  );
  fs.writeFileSync(
    path.join(mainWorkspaceDir, 'USER.md'),
    '# USER.md\n\n- **Timezone:** America/Los_Angeles\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'memory-consolidation-state.json'),
    JSON.stringify({
      version: 1,
      lastCompletedAt: '2026-04-06T08:00:00.000Z',
    }),
    'utf-8',
  );

  const { hasDreamRunToday } = await loadRunner({ dataDir, mainWorkspaceDir });

  expect(hasDreamRunToday(new Date('2026-04-07T00:30:00.000Z'))).toBe(true);
});

test('nextDreamRunAt targets the next midnight in the main workspace timezone', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-dream-runner-next-'),
  );
  const mainWorkspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-dream-runner-main-next-'),
  );
  fs.writeFileSync(
    path.join(mainWorkspaceDir, 'USER.md'),
    '# USER.md\n\n- **Timezone:** America/Los_Angeles\n',
    'utf-8',
  );

  const { nextDreamRunAt } = await loadRunner({ dataDir, mainWorkspaceDir });
  const nextRun = nextDreamRunAt(new Date('2026-04-07T00:30:00.000Z'));

  expect(nextRun.toISOString()).toBe('2026-04-07T07:00:00.000Z');
});

test('nextDreamRunAt ignores invalid USER.md timezone placeholders', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-dream-runner-invalid-tz-'),
  );
  const mainWorkspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-dream-runner-main-invalid-tz-'),
  );
  fs.writeFileSync(
    path.join(mainWorkspaceDir, 'USER.md'),
    '# USER.md\n\n- **Timezone:** _(to be determined)_\n',
    'utf-8',
  );

  const { nextDreamRunAt } = await loadRunner({ dataDir, mainWorkspaceDir });
  const now = new Date('2026-04-07T00:30:00.000Z');

  expect(nextDreamRunAt(now).toISOString()).toBe(
    nextDateBoundaryInTimezone(undefined, now).toISOString(),
  );
});
