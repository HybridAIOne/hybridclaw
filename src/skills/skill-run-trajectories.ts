import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger } from '../logger.js';
import {
  type ConfidentialPlaceholderMap,
  createPlaceholderMap,
  dehydrateConfidential,
} from '../security/confidential-redact.js';
import type { ConfidentialRuleSet } from '../security/confidential-rules.js';
import {
  getConfidentialRuleSet,
  isConfidentialRedactionEnabled,
} from '../security/confidential-runtime.js';
import { redactSecrets } from '../security/redact.js';
import { expandHomePath } from '../utils/path.js';
import type { AdaptiveSkillsConfig } from './adaptive-skills-types.js';
import type {
  SkillRunBoundedPayload,
  SkillRunEvent,
  SkillRunFullPayload,
  SkillRunToolExecutionSummary,
} from './skill-run-events.js';

export const SKILL_RUN_TRAJECTORY_SCHEMA_VERSION = 2;
const SKILL_RUN_TRAJECTORY_DIR_MODE = 0o700;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRAJECTORY_DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
let loggedTrajectoryCaptureConfigKey: string | null = null;

interface TrajectoryScrubStats {
  hits: number;
  redactedStrings: number;
}

export interface SkillRunTrajectoryPayload {
  content: string;
  truncated: boolean;
  source: 'bounded' | 'full';
}

export interface SkillRunTrajectoryToolUse
  extends SkillRunToolExecutionSummary {
  arguments: SkillRunTrajectoryPayload | null;
  result: SkillRunTrajectoryPayload | null;
}

export interface SkillRunTrajectoryScore {
  run: number;
}

export interface SkillRunTrajectoryRecord {
  schema_version: typeof SKILL_RUN_TRAJECTORY_SCHEMA_VERSION;
  captured_at: string;
  date: string;
  tenant_id: string;
  agent_id: string;
  skill_id: string;
  session_id: string;
  run_id: string;
  input: SkillRunTrajectoryPayload | null;
  output: SkillRunTrajectoryPayload | null;
  model: string | null;
  tools_used: SkillRunTrajectoryToolUse[];
  outcome: SkillRunEvent['outcome'];
  score: SkillRunTrajectoryScore;
  event: SkillRunEvent;
}

function safeFilePart(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'unknown';
}

function hashedTenantId(raw: string): string {
  return `agent_${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

function trajectoryStorageTenantId(
  rawAgentId: string,
  ruleSet: ConfidentialRuleSet | null,
): string {
  const confidentialScrubbed = ruleSet
    ? dehydrateConfidential(rawAgentId, ruleSet, createPlaceholderMap()).text
    : rawAgentId;
  const scrubbed = redactSecrets(confidentialScrubbed);
  if (scrubbed !== rawAgentId) return hashedTenantId(rawAgentId);
  return safeFilePart(rawAgentId);
}

export function resolveSkillRunTrajectoryStoreDir(
  config: RuntimeConfig,
): string {
  const configured = config.adaptiveSkills.trajectoryCapture.storeDir.trim();
  if (!configured) {
    return path.join(path.dirname(config.ops.dbPath), 'trajectories');
  }

  const expanded = expandHomePath(configured);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(DEFAULT_RUNTIME_HOME_DIR, expanded);
}

function normalizedTrajectoryCaptureAgentIds(
  config: AdaptiveSkillsConfig,
): string[] {
  const enabledAgentIds = config.trajectoryCapture.enabledAgentIds;
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
  const loggedAgentIds = input.agentIds.map((agentId) =>
    redactSecrets(agentId),
  );
  logger.info(
    {
      agentIds: loggedAgentIds,
      storeDir: input.storeDir,
    },
    `Trajectory capture enabled for agents: [${loggedAgentIds.join(', ')}] -> ${
      input.storeDir
    }`,
  );
}

function isEnabledTrajectoryCaptureAgentId(
  agentId: string | null | undefined,
  enabledAgentIds: string[],
): agentId is string {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId || enabledAgentIds.length === 0) return false;
  return enabledAgentIds.some((enabledAgentId) => {
    return enabledAgentId.trim() === normalizedAgentId;
  });
}

export function isTrajectoryCaptureEnabledForAgentId(
  agentId: string | null | undefined,
  config: RuntimeConfig,
): agentId is string {
  return isEnabledTrajectoryCaptureAgentId(
    agentId,
    config.adaptiveSkills.trajectoryCapture.enabledAgentIds,
  );
}

function isTrajectoryCaptureEnabledForAgent(
  event: SkillRunEvent,
  enabledAgentIds: string[],
): event is SkillRunEvent & { agent_id: string } {
  return isEnabledTrajectoryCaptureAgentId(event.agent_id, enabledAgentIds);
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

function buildTrajectoryPayload(
  bounded: SkillRunBoundedPayload | null,
  full: SkillRunFullPayload | null,
): SkillRunTrajectoryPayload | null {
  if (full) {
    return {
      content: full.content,
      truncated: false,
      source: 'full',
    };
  }
  if (!bounded) return null;
  return {
    content: bounded.content,
    truncated: bounded.truncated,
    source: 'bounded',
  };
}

function buildTrajectoryToolUse(
  summary: SkillRunToolExecutionSummary,
  event: SkillRunEvent,
  index: number,
): SkillRunTrajectoryToolUse {
  const full = event.tool_executions_full[index];
  return {
    ...summary,
    arguments: full ? buildTrajectoryPayload(null, full.arguments) : null,
    result: full ? buildTrajectoryPayload(null, full.result) : null,
  };
}

function scoreSkillRunOutcome(outcome: SkillRunEvent['outcome']): number {
  if (outcome === 'success') return 1;
  if (outcome === 'partial') return 0.5;
  return 0;
}

function buildTrajectoryScore(
  outcome: SkillRunEvent['outcome'],
): SkillRunTrajectoryScore {
  return {
    run: scoreSkillRunOutcome(outcome),
  };
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
    tenant_id: event.agent_id,
    agent_id: event.agent_id,
    skill_id: event.skill_id,
    session_id: event.session_id,
    run_id: event.run_id,
    input: buildTrajectoryPayload(event.input, event.input_full),
    output: buildTrajectoryPayload(event.output, event.output_full),
    model: event.model,
    tools_used: event.tool_executions.map((summary, index) =>
      buildTrajectoryToolUse(summary, event, index),
    ),
    outcome: event.outcome,
    score: buildTrajectoryScore(event.outcome),
    event,
  };
}

function scrubTrajectoryValue(
  value: unknown,
  mappings: ConfidentialPlaceholderMap,
  stats: TrajectoryScrubStats,
  ruleSet: ConfidentialRuleSet | null,
): unknown {
  if (typeof value === 'string') {
    const scrubbed = ruleSet
      ? dehydrateConfidential(value, ruleSet, mappings)
      : { text: value, hits: 0 };
    stats.hits += scrubbed.hits;
    const redacted = redactSecrets(scrubbed.text);
    if (redacted !== value) stats.redactedStrings += 1;
    return redacted;
  }

  if (Array.isArray(value)) {
    let mutated = false;
    const next = value.map((entry) => {
      const scrubbed = scrubTrajectoryValue(entry, mappings, stats, ruleSet);
      if (scrubbed !== entry) mutated = true;
      return scrubbed;
    });
    return mutated ? next : value;
  }

  if (!value || typeof value !== 'object') return value;

  let mutated = false;
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const scrubbed = scrubTrajectoryValue(entry, mappings, stats, ruleSet);
    if (scrubbed !== entry) mutated = true;
    next[key] = scrubbed;
  }
  return mutated ? next : value;
}

function getTrajectoryConfidentialRuleSet(): ConfidentialRuleSet | null {
  if (!isConfidentialRedactionEnabled()) return null;
  return getConfidentialRuleSet();
}

function scrubSkillRunTrajectoryRecord(record: SkillRunTrajectoryRecord): {
  record: SkillRunTrajectoryRecord;
  hits: number;
  placeholderCount: number;
  redactedStringCount: number;
  rulesSource: string | null;
} {
  const ruleSet = getTrajectoryConfidentialRuleSet();
  const mappings = createPlaceholderMap();
  const stats: TrajectoryScrubStats = { hits: 0, redactedStrings: 0 };
  const scrubbed = scrubTrajectoryValue(record, mappings, stats, ruleSet);
  const scrubbedRecord = scrubbed as SkillRunTrajectoryRecord;
  return {
    record: {
      ...scrubbedRecord,
      tenant_id: trajectoryStorageTenantId(record.tenant_id, ruleSet),
    },
    hits: stats.hits,
    placeholderCount: mappings.byPlaceholder.size,
    redactedStringCount: stats.redactedStrings,
    rulesSource: ruleSet?.sourcePath ?? null,
  };
}

function recordTrajectoryScrubAudit(input: {
  record: SkillRunTrajectoryRecord;
  filePath: string;
  hits: number;
  placeholderCount: number;
  redactedStringCount: number;
  rulesSource: string | null;
}): void {
  recordAuditEvent({
    sessionId: input.record.session_id,
    runId: makeAuditRunId('trajectory_scrub'),
    parentRunId: input.record.run_id,
    event: {
      type: 'skill.trajectory.scrub',
      skillName: input.record.skill_id,
      agentId: input.record.agent_id,
      tenantId: input.record.tenant_id,
      trajectoryDate: input.record.date,
      trajectoryFile: path.basename(input.filePath),
      schemaVersion: input.record.schema_version,
      redactor: 'confidential-redact',
      placeholderFormat: '«CONF:<RULE_ID>»',
      matches: input.hits,
      placeholderCount: input.placeholderCount,
      redactedStringCount: input.redactedStringCount,
      rulesSource: input.rulesSource,
    },
  });
}

export function recordSkillRunTrajectory(event: SkillRunEvent): void {
  const config = getRuntimeConfig();
  const enabledAgentIds = normalizedTrajectoryCaptureAgentIds(
    config.adaptiveSkills,
  );
  if (enabledAgentIds.length === 0) {
    loggedTrajectoryCaptureConfigKey = null;
    return;
  }

  const storeDir = resolveSkillRunTrajectoryStoreDir(config);
  logTrajectoryCaptureEnabledOnce({
    agentIds: enabledAgentIds,
    storeDir,
  });
  if (!isTrajectoryCaptureEnabledForAgent(event, enabledAgentIds)) return;

  try {
    const builtRecord = buildSkillRunTrajectoryRecord(event);
    const scrubbed = scrubSkillRunTrajectoryRecord(builtRecord);
    const record = scrubbed.record;
    const filePath = skillRunTrajectoryFilePath({
      storeDir,
      date: record.date,
      agentId: record.tenant_id,
    });
    ensurePrivateTrajectoryDirectories({
      storeDir,
      dateDir: path.dirname(filePath),
    });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    recordTrajectoryScrubAudit({
      record,
      filePath,
      hits: scrubbed.hits,
      placeholderCount: scrubbed.placeholderCount,
      redactedStringCount: scrubbed.redactedStringCount,
      rulesSource: scrubbed.rulesSource,
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

function tenantRetentionDays(
  tenantId: string,
  config: AdaptiveSkillsConfig,
): number {
  const normalizedTenantId = tenantId.trim();
  const overrides = config.trajectoryCapture.retentionDaysByTenant;
  const configured =
    overrides[normalizedTenantId] ??
    overrides[safeFilePart(normalizedTenantId)];
  return configured ?? config.trajectoryCapture.retentionDays;
}

function shouldPruneTrajectoryDate(input: {
  date: string;
  retentionDays: number;
  now: Date;
}): boolean {
  if (input.retentionDays <= 0) return false;
  const cutoffDate = new Date(
    input.now.getTime() - input.retentionDays * MS_PER_DAY,
  )
    .toISOString()
    .slice(0, 10);
  return input.date < cutoffDate;
}

function readTrajectoryTenantId(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .toString('utf-8', 0, bytesRead)
      .split(/\r?\n/, 1)[0]
      ?.trim();
    if (!firstLine) return null;
    const record = JSON.parse(firstLine) as {
      tenant_id?: unknown;
      agent_id?: unknown;
      event?: { agent_id?: unknown };
    };
    for (const candidate of [
      record.tenant_id,
      record.agent_id,
      record.event?.agent_id,
    ]) {
      if (typeof candidate !== 'string') continue;
      const normalized = candidate.trim();
      if (normalized) return normalized;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function removeDateDirIfEmpty(dateDir: string): void {
  try {
    if (fs.readdirSync(dateDir).length === 0) {
      fs.rmdirSync(dateDir);
    }
  } catch {
    // Best-effort cleanup only; a concurrent writer may have added a file.
  }
}

export function pruneExpiredSkillRunTrajectories(input?: {
  config?: RuntimeConfig;
  now?: Date;
}): number {
  const runtimeConfig = input?.config ?? getRuntimeConfig();
  const adaptiveSkills = runtimeConfig.adaptiveSkills;
  if (adaptiveSkills.trajectoryCapture.retentionDays <= 0) return 0;

  const storeDir = resolveSkillRunTrajectoryStoreDir(runtimeConfig);
  if (!fs.existsSync(storeDir)) return 0;

  let prunedFiles = 0;
  const now = input?.now ?? new Date();
  try {
    for (const dateEntry of fs.readdirSync(storeDir, { withFileTypes: true })) {
      if (
        !dateEntry.isDirectory() ||
        !TRAJECTORY_DATE_DIR_PATTERN.test(dateEntry.name)
      ) {
        continue;
      }
      const dateDir = path.join(storeDir, dateEntry.name);
      for (const fileEntry of fs.readdirSync(dateDir, {
        withFileTypes: true,
      })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) {
          continue;
        }
        const filePath = path.join(dateDir, fileEntry.name);
        const fileTenantId =
          readTrajectoryTenantId(filePath) ??
          path.basename(fileEntry.name, '.jsonl');
        if (
          !shouldPruneTrajectoryDate({
            date: dateEntry.name,
            retentionDays: tenantRetentionDays(fileTenantId, adaptiveSkills),
            now,
          })
        ) {
          continue;
        }
        fs.unlinkSync(filePath);
        prunedFiles += 1;
      }
      removeDateDirIfEmpty(dateDir);
    }
  } catch (error) {
    logger.warn(
      { storeDir, error },
      'Failed to prune expired skill run trajectories',
    );
  }
  return prunedFiles;
}
