import fs from 'node:fs';
import path from 'node:path';
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger } from '../logger.js';
import { expandHomePath } from '../utils/path.js';
import type { SkillRunEvent } from './skill-run-events.js';

export const SKILL_RUN_TRAJECTORY_SCHEMA_VERSION = 1;
const SKILL_RUN_TRAJECTORY_DIR_MODE = 0o700;
let loggedTrajectoryCaptureConfigKey: string | null = null;

export interface SkillRunTrajectoryRecord {
  schema_version: typeof SKILL_RUN_TRAJECTORY_SCHEMA_VERSION;
  captured_at: string;
  date: string;
  agent_id: string;
  event: SkillRunEvent;
}

function safeFilePart(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'unknown';
}

function resolveTrajectoryStoreDir(config: RuntimeConfig): string {
  const configured = config.adaptiveSkills.trajectoryCapture.storeDir.trim();
  if (!configured) {
    return path.join(path.dirname(config.ops.dbPath), 'trajectories');
  }

  const expanded = expandHomePath(configured);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(DEFAULT_RUNTIME_HOME_DIR, expanded);
}

function normalizedTrajectoryCaptureAgentIds(config: RuntimeConfig): string[] {
  const enabledAgentIds =
    config.adaptiveSkills.trajectoryCapture.enabledAgentIds;
  if (enabledAgentIds.length === 0) return [];
  return enabledAgentIds.map((agentId) => agentId.trim()).filter(Boolean);
}

function logTrajectoryCaptureEnabledOnce(input: {
  agentIds: string[];
  storeDir: string;
}): void {
  const configKey = `${input.storeDir}\0${input.agentIds.join('\0')}`;
  if (loggedTrajectoryCaptureConfigKey === configKey) return;
  loggedTrajectoryCaptureConfigKey = configKey;
  logger.info(
    {
      agentIds: input.agentIds,
      storeDir: input.storeDir,
    },
    `Trajectory capture enabled for agents: [${input.agentIds.join(', ')}] -> ${
      input.storeDir
    }`,
  );
}

export function isTrajectoryCaptureEnabledForAgentId(
  agentId: string | null | undefined,
  config: RuntimeConfig,
): agentId is string {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) return false;
  const enabledAgentIds =
    config.adaptiveSkills.trajectoryCapture.enabledAgentIds;
  if (enabledAgentIds.length === 0) return false;
  return enabledAgentIds.some((enabledAgentId) => {
    return enabledAgentId.trim() === normalizedAgentId;
  });
}

function isTrajectoryCaptureEnabledForAgent(
  event: SkillRunEvent,
  enabledAgentIds: string[],
): event is SkillRunEvent & { agent_id: string } {
  const agentId = event.agent_id?.trim();
  if (!agentId) return false;
  return enabledAgentIds.includes(agentId);
}

export function skillRunTrajectoryFilePath(input: {
  storeDir: string;
  date: string;
  agentId: string;
}): string {
  return path.join(
    input.storeDir,
    input.date,
    `${safeFilePart(input.agentId)}.jsonl`,
  );
}

function ensurePrivateTrajectoryDirectories(input: {
  storeDir: string;
  dateDir: string;
}): void {
  fs.mkdirSync(input.storeDir, {
    recursive: true,
    mode: SKILL_RUN_TRAJECTORY_DIR_MODE,
  });
  fs.mkdirSync(input.dateDir, {
    recursive: true,
    mode: SKILL_RUN_TRAJECTORY_DIR_MODE,
  });
}

export function buildSkillRunTrajectoryRecord(
  event: SkillRunEvent & { agent_id: string },
  capturedAt = new Date(),
): SkillRunTrajectoryRecord {
  const captured_at = capturedAt.toISOString();
  return {
    schema_version: SKILL_RUN_TRAJECTORY_SCHEMA_VERSION,
    captured_at,
    date: captured_at.slice(0, 10),
    agent_id: event.agent_id,
    event,
  };
}

export function recordSkillRunTrajectory(event: SkillRunEvent): void {
  const config = getRuntimeConfig();
  const enabledAgentIds = normalizedTrajectoryCaptureAgentIds(config);
  if (enabledAgentIds.length === 0) {
    loggedTrajectoryCaptureConfigKey = null;
    return;
  }

  const storeDir = resolveTrajectoryStoreDir(config);
  logTrajectoryCaptureEnabledOnce({
    agentIds: enabledAgentIds,
    storeDir,
  });
  if (!isTrajectoryCaptureEnabledForAgent(event, enabledAgentIds)) return;

  try {
    const record = buildSkillRunTrajectoryRecord(event);
    const filePath = skillRunTrajectoryFilePath({
      storeDir,
      date: record.date,
      agentId: record.agent_id,
    });
    ensurePrivateTrajectoryDirectories({
      storeDir,
      dateDir: path.dirname(filePath),
    });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (error) {
    logger.warn(
      {
        sessionId: event.session_id,
        runId: event.run_id,
        skillId: event.skill_id,
        agentId: event.agent_id,
        error,
      },
      'Failed to append skill run trajectory',
    );
  }
}
