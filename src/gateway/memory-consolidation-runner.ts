import fs from 'node:fs';
import path from 'node:path';

import {
  currentDateStampInTimezone,
  extractUserTimezone,
  nextDateBoundaryInTimezone,
} from '../../container/shared/workspace-time.js';
import { DATA_DIR, getConfigSnapshot } from '../config/config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import type { MemoryConsolidationReport } from '../memory/memory-consolidation.js';
import { memoryService } from '../memory/memory-service.js';

export type MemoryConsolidationTrigger = 'nightly' | 'startup' | 'manual';

interface MemoryConsolidationState {
  version: number;
  lastCompletedAt: string | null;
}

const MEMORY_CONSOLIDATION_STATE_VERSION = 1;
const MEMORY_CONSOLIDATION_STATE_PATH = path.join(
  DATA_DIR,
  'memory-consolidation-state.json',
);

let memoryConsolidationRunning = false;
const memoryConsolidationState = loadMemoryConsolidationState();

function loadMemoryConsolidationState(): MemoryConsolidationState {
  try {
    if (!fs.existsSync(MEMORY_CONSOLIDATION_STATE_PATH)) {
      return {
        version: MEMORY_CONSOLIDATION_STATE_VERSION,
        lastCompletedAt: null,
      };
    }
    const raw = fs.readFileSync(MEMORY_CONSOLIDATION_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as {
      lastCompletedAt?: unknown;
      version?: unknown;
    };
    return {
      version:
        typeof parsed.version === 'number' &&
        Number.isFinite(parsed.version) &&
        parsed.version > 0
          ? parsed.version
          : MEMORY_CONSOLIDATION_STATE_VERSION,
      lastCompletedAt:
        typeof parsed.lastCompletedAt === 'string' &&
        parsed.lastCompletedAt.trim()
          ? parsed.lastCompletedAt.trim()
          : null,
    };
  } catch (error) {
    logger.warn(
      { error },
      'Failed to load memory consolidation state; starting fresh',
    );
    return {
      version: MEMORY_CONSOLIDATION_STATE_VERSION,
      lastCompletedAt: null,
    };
  }
}

function persistMemoryConsolidationState(): void {
  try {
    fs.mkdirSync(path.dirname(MEMORY_CONSOLIDATION_STATE_PATH), {
      recursive: true,
    });
    const payload = `${JSON.stringify(memoryConsolidationState, null, 2)}\n`;
    const tempPath = `${MEMORY_CONSOLIDATION_STATE_PATH}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tempPath, payload, 'utf-8');
    fs.renameSync(tempPath, MEMORY_CONSOLIDATION_STATE_PATH);
  } catch (error) {
    logger.warn({ error }, 'Failed to persist memory consolidation state');
  }
}

export function getDreamTimezone(): string | undefined {
  try {
    const userPath = path.join(agentWorkspaceDir('main'), 'USER.md');
    if (!fs.existsSync(userPath)) return undefined;
    return extractUserTimezone(fs.readFileSync(userPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

export function hasDreamRunToday(now = new Date()): boolean {
  const lastCompletedAt = memoryConsolidationState.lastCompletedAt;
  if (!lastCompletedAt) return false;
  const lastRun = new Date(lastCompletedAt);
  if (Number.isNaN(lastRun.getTime())) return false;
  const timezone = getDreamTimezone();
  return (
    currentDateStampInTimezone(timezone, lastRun) ===
    currentDateStampInTimezone(timezone, now)
  );
}

export function nextDreamRunAt(now = new Date()): Date {
  return nextDateBoundaryInTimezone(getDreamTimezone(), now);
}

export function isMemoryConsolidationEnabled(): boolean {
  return (
    Math.max(
      0,
      Math.trunc(getConfigSnapshot().memory.consolidationIntervalHours),
    ) > 0
  );
}

export async function runMemoryConsolidation(params: {
  trigger: MemoryConsolidationTrigger;
  requireSchedulerEnabled?: boolean;
}): Promise<MemoryConsolidationReport | null> {
  if (params.requireSchedulerEnabled && !isMemoryConsolidationEnabled()) {
    return null;
  }
  if (memoryConsolidationRunning) {
    logger.info(
      { trigger: params.trigger },
      'Memory consolidation already running',
    );
    return null;
  }

  const { decayRate, consolidationLanguage } = getConfigSnapshot().memory;
  memoryConsolidationRunning = true;
  try {
    logger.info(
      {
        trigger: params.trigger,
        decayRate,
        consolidationLanguage,
      },
      'Memory consolidation started',
    );
    memoryService.setConsolidationDecayRate(decayRate);
    memoryService.setConsolidationLanguage(consolidationLanguage);
    const report = await memoryService.consolidateMemoriesWithCleanup();
    memoryConsolidationState.lastCompletedAt = new Date().toISOString();
    persistMemoryConsolidationState();
    logger.info(
      {
        trigger: params.trigger,
        decayed: report.memoriesDecayed,
        durationMs: report.durationMs,
        decayRate,
        dailyFilesCompiled: report.dailyFilesCompiled,
        workspacesUpdated: report.workspacesUpdated,
        modelCleanups: report.modelCleanups,
        fallbacksUsed: report.fallbacksUsed,
      },
      'Memory consolidation completed',
    );
    return report;
  } catch (error) {
    logger.warn(
      { error, decayRate, trigger: params.trigger },
      'Memory consolidation failed',
    );
    throw error;
  } finally {
    memoryConsolidationRunning = false;
  }
}
