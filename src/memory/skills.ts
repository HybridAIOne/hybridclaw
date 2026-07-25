import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  SkillAmendment,
  SkillAmendmentProposalMetadata,
  SkillAmendmentStatus,
  SkillErrorCategory,
  SkillExecutionOutcome,
  SkillFeedbackSentiment,
  SkillHealthMetrics,
  SkillObservation,
  SkillObservationSummary,
  SkillOptLiteEdit,
  SkillOptLiteRejectedEditMemory,
} from '../skills/adaptive-skills-types.js';
import type { SkillGuardVerdict } from '../skills/skills-guard.js';
import { withMemoryDatabase } from './database.js';
import { queryAll, queryOne } from './sqlite.js';

type SkillObservationRow = Omit<
  SkillObservation,
  'outcome' | 'error_category' | 'feedback_sentiment'
> & {
  outcome: string;
  error_category: string | null;
  feedback_sentiment: string | null;
};

type SkillObservationSummaryRow = Omit<
  SkillObservationSummary,
  'error_clusters'
>;

type SkillObservationErrorClusterRow = {
  skill_name: SkillObservationSummary['skill_name'];
  error_category: SkillErrorCategory | null;
  count: number;
  sample_detail: string | null;
};

type SkillAmendmentRow = Omit<
  SkillAmendment,
  | 'guard_verdict'
  | 'metrics_at_proposal'
  | 'metrics_post_apply'
  | 'proposal_metadata'
> & {
  guard_verdict: string;
  metrics_at_proposal: string | null;
  metrics_post_apply: string | null;
  proposal_metadata: string | null;
};

type SkillOptLiteRejectedEditRow = SkillOptLiteRejectedEditMemory;

function getSkillDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
}

function parseSkillMetricsJson(raw: string | null): SkillHealthMetrics | null {
  const normalized = raw?.trim() || '';
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SkillHealthMetrics;
  } catch {
    return null;
  }
}

function serializeSkillMetricsJson(
  metrics: SkillHealthMetrics | null | undefined,
): string | null {
  if (!metrics) return null;
  try {
    return JSON.stringify(metrics);
  } catch {
    return null;
  }
}

function parseSkillAmendmentProposalMetadataJson(
  raw: string | null,
): SkillAmendmentProposalMetadata | null {
  const normalized = raw?.trim() || '';
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SkillAmendmentProposalMetadata;
  } catch {
    return null;
  }
}

function serializeSkillAmendmentProposalMetadataJson(
  metadata: SkillAmendmentProposalMetadata | null | undefined,
): string | null {
  if (!metadata) return null;
  try {
    return JSON.stringify(metadata);
  } catch {
    return null;
  }
}

function normalizeSkillOutcome(
  value: string | null | undefined,
): SkillExecutionOutcome {
  if (value === 'success' || value === 'failure' || value === 'partial') {
    return value;
  }
  return 'failure';
}

function normalizeSkillErrorCategoryValue(
  value: string | null | undefined,
): SkillErrorCategory | null {
  if (
    value === 'tool_error' ||
    value === 'timeout' ||
    value === 'user_abort' ||
    value === 'model_error' ||
    value === 'env_changed' ||
    value === 'unknown'
  ) {
    return value;
  }
  return null;
}

function normalizeSkillFeedbackSentimentValue(
  value: string | null | undefined,
): SkillFeedbackSentiment | null {
  if (value === 'positive' || value === 'negative' || value === 'neutral') {
    return value;
  }
  return null;
}

function normalizeSkillAmendmentStatusValue(
  value: string | null | undefined,
): SkillAmendmentStatus {
  if (
    value === 'staged' ||
    value === 'applied' ||
    value === 'rolled_back' ||
    value === 'rejected'
  ) {
    return value;
  }
  return 'staged';
}

function normalizeSkillGuardVerdictValue(
  value: string | null | undefined,
): SkillGuardVerdict {
  if (value === 'safe' || value === 'caution' || value === 'dangerous') {
    return value;
  }
  return 'caution';
}

function mapSkillObservationRow(row: SkillObservationRow): SkillObservation {
  return {
    id: Math.floor(row.id),
    skill_name: row.skill_name,
    agent_id: row.agent_id,
    session_id: row.session_id,
    run_id: row.run_id,
    outcome: normalizeSkillOutcome(row.outcome),
    error_category: normalizeSkillErrorCategoryValue(row.error_category),
    error_detail: row.error_detail,
    tool_calls_attempted: Math.max(
      0,
      Math.floor(row.tool_calls_attempted || 0),
    ),
    tool_calls_failed: Math.max(0, Math.floor(row.tool_calls_failed || 0)),
    duration_ms: Math.max(0, Math.floor(row.duration_ms || 0)),
    user_feedback: row.user_feedback,
    feedback_sentiment: normalizeSkillFeedbackSentimentValue(
      row.feedback_sentiment,
    ),
    created_at: row.created_at,
  };
}

function mapSkillAmendmentRow(row: SkillAmendmentRow): SkillAmendment {
  return {
    id: Math.floor(row.id),
    skill_name: row.skill_name,
    skill_file_path: row.skill_file_path,
    version: Math.max(1, Math.floor(row.version || 1)),
    previous_version:
      typeof row.previous_version === 'number'
        ? Math.floor(row.previous_version)
        : null,
    status: normalizeSkillAmendmentStatusValue(row.status),
    original_content: row.original_content,
    proposed_content: row.proposed_content,
    original_content_hash: row.original_content_hash,
    proposed_content_hash: row.proposed_content_hash,
    rationale: row.rationale,
    diff_summary: row.diff_summary,
    proposed_by: row.proposed_by,
    reviewed_by: row.reviewed_by,
    guard_verdict: normalizeSkillGuardVerdictValue(row.guard_verdict),
    guard_findings_count: Math.max(
      0,
      Math.floor(row.guard_findings_count || 0),
    ),
    metrics_at_proposal: parseSkillMetricsJson(row.metrics_at_proposal),
    metrics_post_apply: parseSkillMetricsJson(row.metrics_post_apply),
    proposal_metadata: parseSkillAmendmentProposalMetadataJson(
      row.proposal_metadata,
    ),
    runs_since_apply: Math.max(0, Math.floor(row.runs_since_apply || 0)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    applied_at: row.applied_at,
    rolled_back_at: row.rolled_back_at,
    rejected_at: row.rejected_at,
  };
}

function mapSkillObservationSummaries(params: {
  summaryRows: SkillObservationSummaryRow[];
  clusterRows: SkillObservationErrorClusterRow[];
}): SkillObservationSummary[] {
  const clusterMap = new Map<
    string,
    Array<{
      category: SkillErrorCategory;
      count: number;
      sample_detail?: string | null;
    }>
  >();
  for (const row of params.clusterRows) {
    const skillName = row.skill_name.trim();
    if (!skillName) continue;
    const category =
      normalizeSkillErrorCategoryValue(row.error_category) || 'unknown';
    const existing = clusterMap.get(skillName) || [];
    existing.push({
      category,
      count: Math.max(0, Math.floor(row.count || 0)),
      sample_detail: row.sample_detail,
    });
    clusterMap.set(skillName, existing);
  }

  return params.summaryRows.map((row) => ({
    skill_name: row.skill_name,
    total_executions: Math.max(0, Math.floor(row.total_executions || 0)),
    success_count: Math.max(0, Math.floor(row.success_count || 0)),
    failure_count: Math.max(0, Math.floor(row.failure_count || 0)),
    partial_count: Math.max(0, Math.floor(row.partial_count || 0)),
    avg_duration_ms: Math.max(0, Number(row.avg_duration_ms || 0)),
    tool_calls_attempted: Math.max(
      0,
      Math.floor(row.tool_calls_attempted || 0),
    ),
    tool_calls_failed: Math.max(0, Math.floor(row.tool_calls_failed || 0)),
    positive_feedback_count: Math.max(
      0,
      Math.floor(row.positive_feedback_count || 0),
    ),
    negative_feedback_count: Math.max(
      0,
      Math.floor(row.negative_feedback_count || 0),
    ),
    error_clusters: clusterMap.get(row.skill_name) || [],
    last_observed_at: row.last_observed_at,
  }));
}

export function recordSkillObservation(input: {
  skillName: string;
  sessionId: string;
  runId: string;
  agentId?: string | null;
  outcome: SkillExecutionOutcome;
  errorCategory?: SkillErrorCategory | null;
  errorDetail?: string | null;
  toolCallsAttempted?: number;
  toolCallsFailed?: number;
  durationMs?: number;
}): SkillObservation {
  const result = getSkillDatabase()
    .prepare(
      `INSERT INTO skill_observations (
         skill_name,
         agent_id,
         session_id,
         run_id,
         outcome,
         error_category,
         error_detail,
         tool_calls_attempted,
         tool_calls_failed,
         duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.skillName.trim(),
      input.agentId?.trim() || null,
      input.sessionId.trim(),
      input.runId.trim(),
      input.outcome,
      input.errorCategory || null,
      input.errorDetail?.trim() || null,
      Math.max(0, Math.floor(input.toolCallsAttempted || 0)),
      Math.max(0, Math.floor(input.toolCallsFailed || 0)),
      Math.max(0, Math.floor(input.durationMs || 0)),
    );

  const row = queryOne<SkillObservationRow, [number | bigint]>(
    getSkillDatabase(),
    'SELECT * FROM skill_observations WHERE id = ?',
    result.lastInsertRowid,
  );
  if (!row) {
    throw new Error('Failed to read persisted skill observation.');
  }
  return mapSkillObservationRow(row);
}

export function getSkillObservations(params?: {
  skillName?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  createdAfter?: string | null;
  limit?: number;
}): SkillObservation[] {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  const skillName = params?.skillName?.trim() || '';
  const sessionId = params?.sessionId?.trim() || '';
  const agentId = params?.agentId?.trim() || '';
  const runId = params?.runId?.trim() || '';
  const createdAfter = params?.createdAfter?.trim() || '';
  if (skillName) {
    clauses.push('skill_name = ?');
    args.push(skillName);
  }
  if (sessionId) {
    clauses.push('session_id = ?');
    args.push(sessionId);
  }
  if (agentId) {
    clauses.push('agent_id = ?');
    args.push(agentId);
  }
  if (runId) {
    clauses.push('run_id = ?');
    args.push(runId);
  }
  if (createdAfter) {
    clauses.push('created_at >= ?');
    args.push(createdAfter);
  }
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(params?.limit || 100, 1_000));
  return queryAll<SkillObservationRow, Array<string | number>>(
    getSkillDatabase(),
    `SELECT *
     FROM skill_observations
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    ...args,
    limit,
  ).map(mapSkillObservationRow);
}

export function getObservedSkillNames(params?: {
  createdAfter?: string | null;
}): string[] {
  const createdAfter = params?.createdAfter?.trim() || '';
  const rows = createdAfter
    ? queryAll<{ skill_name: string }, [string]>(
        getSkillDatabase(),
        `SELECT DISTINCT skill_name
         FROM skill_observations
         WHERE created_at >= ?
         ORDER BY skill_name ASC`,
        createdAfter,
      )
    : queryAll<{ skill_name: string }>(
        getSkillDatabase(),
        `SELECT DISTINCT skill_name
         FROM skill_observations
         ORDER BY skill_name ASC`,
      );
  return rows.map((row) => row.skill_name.trim()).filter(Boolean);
}

export function pruneSkillObservations(params: {
  createdBefore: string;
}): number {
  const createdBefore = params.createdBefore.trim();
  if (!createdBefore) return 0;
  const result = getSkillDatabase()
    .prepare(
      `DELETE FROM skill_observations
       WHERE created_at < ?`,
    )
    .run(createdBefore);
  return Math.max(0, Number(result.changes || 0));
}

export function getSkillObservationSummary(params?: {
  skillName?: string;
  agentId?: string;
  createdAfter?: string | null;
}): SkillObservationSummary[] {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  const skillName = params?.skillName?.trim() || '';
  const agentId = params?.agentId?.trim() || '';
  const createdAfter = params?.createdAfter?.trim() || '';
  if (skillName) {
    clauses.push('skill_name = ?');
    args.push(skillName);
  }
  if (createdAfter) {
    clauses.push('created_at >= ?');
    args.push(createdAfter);
  }
  if (agentId) {
    clauses.push('agent_id = ?');
    args.push(agentId);
  }
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const summaryRows = queryAll<
    SkillObservationSummaryRow,
    Array<string | number>
  >(
    getSkillDatabase(),
    `SELECT
       skill_name,
       COUNT(*) AS total_executions,
       SUM(CASE WHEN outcome = 'success' AND COALESCE(tool_calls_failed, 0) = 0 THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count,
       SUM(CASE WHEN outcome = 'partial' OR (outcome = 'success' AND COALESCE(tool_calls_failed, 0) > 0) THEN 1 ELSE 0 END) AS partial_count,
       AVG(duration_ms) AS avg_duration_ms,
       COALESCE(SUM(tool_calls_attempted), 0) AS tool_calls_attempted,
       COALESCE(SUM(tool_calls_failed), 0) AS tool_calls_failed,
       SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
       SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
       MAX(created_at) AS last_observed_at
     FROM skill_observations
     ${whereClause}
     GROUP BY skill_name
     ORDER BY skill_name ASC`,
    ...args,
  );

  if (summaryRows.length === 0) return [];

  const clusterClauses = [
    ...clauses,
    "(outcome != 'success' OR COALESCE(tool_calls_failed, 0) > 0)",
  ];
  const clusterWhereClause =
    clusterClauses.length > 0 ? `WHERE ${clusterClauses.join(' AND ')}` : '';
  const clusterRows = queryAll<
    SkillObservationErrorClusterRow,
    Array<string | number>
  >(
    getSkillDatabase(),
    `SELECT
       skill_name,
       COALESCE(NULLIF(TRIM(error_category), ''), 'unknown') AS error_category,
       COUNT(*) AS count,
       MIN(error_detail) AS sample_detail
     FROM skill_observations
     ${clusterWhereClause}
     GROUP BY skill_name, COALESCE(NULLIF(TRIM(error_category), ''), 'unknown')
     ORDER BY skill_name ASC, count DESC`,
    ...args,
  );

  return mapSkillObservationSummaries({
    summaryRows,
    clusterRows,
  });
}

export function attachFeedbackToObservation(input: {
  sessionId: string;
  feedback: string;
  sentiment: SkillFeedbackSentiment;
}): SkillObservation | null {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return null;
  const target = queryOne<{ id: number }, [string]>(
    getSkillDatabase(),
    `SELECT id
     FROM skill_observations
     WHERE session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    sessionId,
  );
  if (!target) return null;

  getSkillDatabase()
    .prepare(
      `UPDATE skill_observations
     SET user_feedback = ?,
         feedback_sentiment = ?
     WHERE id = ?`,
    )
    .run(input.feedback.trim() || null, input.sentiment, target.id);

  const row = queryOne<SkillObservationRow, [number]>(
    getSkillDatabase(),
    'SELECT * FROM skill_observations WHERE id = ?',
    target.id,
  );
  if (!row) {
    throw new Error('Failed to read updated skill observation.');
  }
  return mapSkillObservationRow(row);
}

export function attachFeedbackToObservationById(input: {
  observationId: number;
  feedback: string;
  sentiment: SkillFeedbackSentiment;
}): SkillObservation | null {
  const observationId = Math.floor(input.observationId);
  if (!Number.isInteger(observationId) || observationId <= 0) return null;

  const result = getSkillDatabase()
    .prepare(
      `UPDATE skill_observations
       SET user_feedback = ?,
           feedback_sentiment = ?
       WHERE id = ?`,
    )
    .run(input.feedback.trim() || null, input.sentiment, observationId);
  if (Number(result.changes || 0) <= 0) return null;

  const row = queryOne<SkillObservationRow, [number]>(
    getSkillDatabase(),
    'SELECT * FROM skill_observations WHERE id = ?',
    observationId,
  );
  if (!row) {
    throw new Error('Failed to read updated skill observation.');
  }
  return mapSkillObservationRow(row);
}

export function createSkillAmendment(input: {
  skillName: string;
  skillFilePath: string;
  previousVersion?: number | null;
  status?: SkillAmendmentStatus;
  originalContent: string;
  proposedContent: string;
  originalContentHash: string;
  proposedContentHash: string;
  rationale: string;
  diffSummary: string;
  proposedBy: string;
  reviewedBy?: string | null;
  guardVerdict: SkillGuardVerdict;
  guardFindingsCount?: number;
  metricsAtProposal?: SkillHealthMetrics | null;
  metricsPostApply?: SkillHealthMetrics | null;
  proposalMetadata?: SkillAmendmentProposalMetadata | null;
  runsSinceApply?: number;
}): SkillAmendment {
  const skillName = input.skillName.trim();
  const latest = queryOne<Pick<SkillAmendment, 'version'>, [string]>(
    getSkillDatabase(),
    `SELECT version
     FROM skill_amendments
     WHERE skill_name = ?
     ORDER BY version DESC
     LIMIT 1`,
    skillName,
  );
  const version = Math.max(1, Math.floor((latest?.version || 0) + 1));
  const result = getSkillDatabase()
    .prepare(
      `INSERT INTO skill_amendments (
         skill_name,
         skill_file_path,
         version,
         previous_version,
         status,
         original_content,
         proposed_content,
         original_content_hash,
         proposed_content_hash,
         rationale,
         diff_summary,
         proposed_by,
         reviewed_by,
         guard_verdict,
         guard_findings_count,
         metrics_at_proposal,
         metrics_post_apply,
         proposal_metadata,
         runs_since_apply
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      skillName,
      input.skillFilePath,
      version,
      typeof input.previousVersion === 'number'
        ? Math.floor(input.previousVersion)
        : null,
      input.status || 'staged',
      input.originalContent,
      input.proposedContent,
      input.originalContentHash,
      input.proposedContentHash,
      input.rationale.trim(),
      input.diffSummary.trim(),
      input.proposedBy.trim(),
      input.reviewedBy?.trim() || null,
      input.guardVerdict,
      Math.max(0, Math.floor(input.guardFindingsCount || 0)),
      serializeSkillMetricsJson(input.metricsAtProposal),
      serializeSkillMetricsJson(input.metricsPostApply),
      serializeSkillAmendmentProposalMetadataJson(input.proposalMetadata),
      Math.max(0, Math.floor(input.runsSinceApply || 0)),
    );

  const row = queryOne<SkillAmendmentRow, [number | bigint]>(
    getSkillDatabase(),
    'SELECT * FROM skill_amendments WHERE id = ?',
    result.lastInsertRowid,
  );
  if (!row) {
    throw new Error('Failed to read persisted skill amendment.');
  }
  return mapSkillAmendmentRow(row);
}

function skillOptLiteEditHash(edit: SkillOptLiteEdit): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        op: edit.op,
        target: edit.target.trim(),
        content: edit.content.trim(),
      }),
    )
    .digest('hex');
}

function mapSkillOptLiteRejectedEditRow(
  row: SkillOptLiteRejectedEditRow,
): SkillOptLiteRejectedEditMemory {
  return {
    id: Math.floor(row.id),
    skill_name: row.skill_name,
    edit_hash: row.edit_hash,
    op: row.op,
    target: row.target,
    content_preview: row.content_preview,
    rationale: row.rationale,
    source_type: row.source_type,
    support_count: Math.max(1, Math.floor(row.support_count || 1)),
    reason: row.reason,
    evidence_source: row.evidence_source,
    created_at: row.created_at,
  };
}

export function recordSkillOptLiteRejectedEdits(input: {
  skillName: string;
  edits: SkillOptLiteEdit[];
  reason: string;
  evidenceSource?: 'trajectories' | 'observations' | null;
}): number {
  const skillName = input.skillName.trim();
  if (!skillName || input.edits.length === 0) return 0;
  const reason = input.reason.trim() || 'Rejected by SkillOpt-lite gate.';
  const insert = getSkillDatabase().prepare(
    `INSERT INTO skillopt_rejected_edits (
       skill_name,
       edit_hash,
       op,
       target,
       content_preview,
       rationale,
       source_type,
       support_count,
       reason,
       evidence_source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_name, edit_hash) DO UPDATE SET
       reason = excluded.reason,
       evidence_source = excluded.evidence_source,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const transaction = getSkillDatabase().transaction(
    (edits: SkillOptLiteEdit[]) => {
      let written = 0;
      for (const edit of edits) {
        const result = insert.run(
          skillName,
          skillOptLiteEditHash(edit),
          edit.op,
          edit.target,
          edit.content.trim().slice(0, 200),
          edit.rationale.trim(),
          edit.source_type,
          Math.max(1, Math.floor(edit.support_count || 1)),
          reason,
          input.evidenceSource || null,
        );
        written += result.changes > 0 ? 1 : 0;
      }
      return written;
    },
  );
  return transaction(input.edits);
}

export function getSkillOptLiteRejectedEdits(input: {
  skillName: string;
  limit?: number;
}): SkillOptLiteRejectedEditMemory[] {
  const skillName = input.skillName.trim();
  if (!skillName) return [];
  const limit = Math.max(0, Math.min(input.limit ?? 20, 100));
  if (limit === 0) return [];
  return queryAll<SkillOptLiteRejectedEditRow, [string, number]>(
    getSkillDatabase(),
    `SELECT *
     FROM skillopt_rejected_edits
     WHERE skill_name = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    skillName,
    limit,
  ).map(mapSkillOptLiteRejectedEditRow);
}

export function getSkillAmendmentById(
  amendmentId: number,
): SkillAmendment | null {
  const row = queryOne<SkillAmendmentRow, [number]>(
    getSkillDatabase(),
    'SELECT * FROM skill_amendments WHERE id = ?',
    Math.floor(amendmentId),
  );
  return row ? mapSkillAmendmentRow(row) : null;
}

export function getLatestSkillAmendment(params: {
  skillName: string;
  status?: SkillAmendmentStatus | SkillAmendmentStatus[];
}): SkillAmendment | null {
  const skillName = params.skillName.trim();
  if (!skillName) return null;
  const statuses = Array.isArray(params.status)
    ? params.status
    : params.status
      ? [params.status]
      : [];
  const clauses = ['skill_name = ?'];
  const args: Array<string | number> = [skillName];
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    args.push(...statuses);
  }
  const row = queryOne<SkillAmendmentRow, Array<string | number>>(
    getSkillDatabase(),
    `SELECT *
     FROM skill_amendments
     WHERE ${clauses.join(' AND ')}
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    ...args,
  );
  return row ? mapSkillAmendmentRow(row) : null;
}

export function getStagedAmendments(): SkillAmendment[] {
  return queryAll<SkillAmendmentRow>(
    getSkillDatabase(),
    `SELECT *
     FROM skill_amendments
     WHERE status = 'staged'
     ORDER BY created_at DESC, id DESC`,
  ).map(mapSkillAmendmentRow);
}

export function updateAmendmentStatus(input: {
  amendmentId: number;
  status: SkillAmendmentStatus;
  reviewedBy?: string | null;
  metricsPostApply?: SkillHealthMetrics | null;
  resetRunsSinceApply?: boolean;
}): SkillAmendment | null {
  const amendmentId = Math.floor(input.amendmentId);
  if (!Number.isFinite(amendmentId) || amendmentId <= 0) return null;

  const reviewedBy = input.reviewedBy?.trim() || null;
  const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const extraAssignments: string[] = [];
  if (reviewedBy) {
    extraAssignments.push('reviewed_by = ?');
  }
  if (typeof input.metricsPostApply !== 'undefined') {
    extraAssignments.push('metrics_post_apply = ?');
  }
  if (input.status === 'applied') {
    extraAssignments.push(`applied_at = COALESCE(applied_at, ${nowSql})`);
    if (input.resetRunsSinceApply !== false) {
      extraAssignments.push('runs_since_apply = 0');
    }
  } else if (input.status === 'rolled_back') {
    extraAssignments.push(`rolled_back_at = ${nowSql}`);
  } else if (input.status === 'rejected') {
    extraAssignments.push(`rejected_at = ${nowSql}`);
  }

  const sql = `
    UPDATE skill_amendments
    SET status = ?,
        updated_at = ${nowSql}
        ${extraAssignments.length > 0 ? `, ${extraAssignments.join(', ')}` : ''}
    WHERE id = ?
  `;
  const args: Array<string | number | null> = [input.status];
  if (reviewedBy) args.push(reviewedBy);
  if (typeof input.metricsPostApply !== 'undefined') {
    args.push(serializeSkillMetricsJson(input.metricsPostApply));
  }
  args.push(amendmentId);
  getSkillDatabase()
    .prepare(sql)
    .run(...args);
  return getSkillAmendmentById(amendmentId);
}

export function incrementAmendmentRunCount(
  skillName: string,
): SkillAmendment | null {
  const target = getLatestSkillAmendment({
    skillName,
    status: 'applied',
  });
  if (!target) return null;
  getSkillDatabase()
    .prepare(
      `UPDATE skill_amendments
     SET runs_since_apply = runs_since_apply + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    )
    .run(target.id);
  return getSkillAmendmentById(target.id);
}

export function getAmendmentHistory(skillName: string): SkillAmendment[] {
  const normalized = skillName.trim();
  if (!normalized) return [];
  return queryAll<SkillAmendmentRow, [string]>(
    getSkillDatabase(),
    `SELECT *
     FROM skill_amendments
     WHERE skill_name = ?
     ORDER BY version DESC, id DESC`,
    normalized,
  ).map(mapSkillAmendmentRow);
}
