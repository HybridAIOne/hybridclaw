import type Database from 'better-sqlite3';
import type { AgentSkillScore } from '../skills/adaptive-skills-types.js';
import { withMemoryDatabase } from './database.js';
import { queryAll, queryOne } from './sqlite.js';

function createSkillScoreStore(database: Database.Database) {
  interface AgentSkillScoreAggregate {
    agent_id: string;
    skill_id: string;
    success_count: number;
    failure_count: number;
    partial_count: number;
    avg_duration_ms: number;
    last_run_at: string | null;
    positive_feedback_count: number;
    negative_feedback_count: number;
    tool_calls_attempted: number;
    tool_calls_failed: number;
  }

  const AGENT_SKILL_SUCCESS_POINTS = 100;
  const AGENT_SKILL_PARTIAL_POINTS = 75;
  const AGENT_SKILL_FAILURE_POINTS = 10;
  const AGENT_SKILL_FEEDBACK_POINT_STEP = 5;
  const AGENT_SKILL_MAX_FEEDBACK_POINTS = 15;
  const AGENT_SKILL_MAX_SCORE = 100;
  const AGENT_SKILL_RELIABILITY_ERROR_WEIGHT = 70;
  const AGENT_SKILL_RELIABILITY_RETRY_WEIGHT = 10;
  const AGENT_SKILL_MAX_RETRY_PENALTY = 30;
  const AGENT_SKILL_TIMING_BASELINE_MS = 30_000;
  const AGENT_SKILL_TIMING_PENALTY_STEP = 20;
  const AGENT_SKILL_QUALITY_WEIGHT = 0.6;
  const AGENT_SKILL_RELIABILITY_WEIGHT = 0.25;
  const AGENT_SKILL_TIMING_WEIGHT = 0.15;

  function clampAgentSkillScore(value: number): number {
    return Math.max(0, Math.min(AGENT_SKILL_MAX_SCORE, Math.round(value)));
  }

  function scoreAgentSkillQuality(row: {
    total_executions: number;
    success_count: number;
    failure_count: number;
    partial_count: number;
    positive_feedback_count: number;
    negative_feedback_count: number;
  }): number {
    const resultPoints =
      row.total_executions > 0
        ? (row.success_count * AGENT_SKILL_SUCCESS_POINTS +
            row.partial_count * AGENT_SKILL_PARTIAL_POINTS +
            row.failure_count * AGENT_SKILL_FAILURE_POINTS) /
          row.total_executions
        : 0;
    const feedbackBalance =
      row.positive_feedback_count - row.negative_feedback_count;
    const feedbackPoints = Math.max(
      -AGENT_SKILL_MAX_FEEDBACK_POINTS,
      Math.min(
        AGENT_SKILL_MAX_FEEDBACK_POINTS,
        feedbackBalance * AGENT_SKILL_FEEDBACK_POINT_STEP,
      ),
    );
    return clampAgentSkillScore(resultPoints + feedbackPoints);
  }

  function scoreAgentSkillReliability(row: {
    total_executions: number;
    tool_calls_attempted: number;
    tool_calls_failed: number;
  }): number {
    const failureRate =
      row.tool_calls_attempted > 0
        ? row.tool_calls_failed / row.tool_calls_attempted
        : 0;
    const avgToolCalls =
      row.total_executions > 0
        ? row.tool_calls_attempted / row.total_executions
        : 0;
    const retryPenalty = Math.min(
      AGENT_SKILL_MAX_RETRY_PENALTY,
      Math.max(0, avgToolCalls - 1) * AGENT_SKILL_RELIABILITY_RETRY_WEIGHT,
    );
    return clampAgentSkillScore(
      AGENT_SKILL_MAX_SCORE -
        failureRate * AGENT_SKILL_RELIABILITY_ERROR_WEIGHT -
        retryPenalty,
    );
  }

  function scoreAgentSkillTiming(avgDurationMs: number): number {
    if (avgDurationMs <= 0) return AGENT_SKILL_MAX_SCORE;
    const penalty =
      Math.log2(avgDurationMs / AGENT_SKILL_TIMING_BASELINE_MS + 1) *
      AGENT_SKILL_TIMING_PENALTY_STEP;
    return clampAgentSkillScore(AGENT_SKILL_MAX_SCORE - penalty);
  }

  function scoreAgentSkillOverall(row: {
    quality_score: number;
    reliability_score: number;
    timing_score: number;
  }): number {
    return clampAgentSkillScore(
      row.quality_score * AGENT_SKILL_QUALITY_WEIGHT +
        row.reliability_score * AGENT_SKILL_RELIABILITY_WEIGHT +
        row.timing_score * AGENT_SKILL_TIMING_WEIGHT,
    );
  }

  function mapAgentSkillScoreRow(
    row: AgentSkillScoreAggregate,
  ): AgentSkillScore {
    const successCount = Math.max(0, Math.floor(row.success_count || 0));
    const failureCount = Math.max(0, Math.floor(row.failure_count || 0));
    const partialCount = Math.max(0, Math.floor(row.partial_count || 0));
    const totalExecutions = successCount + failureCount + partialCount;
    const toolCallsAttempted = Math.max(
      0,
      Math.floor(row.tool_calls_attempted || 0),
    );
    const toolCallsFailed = Math.max(0, Math.floor(row.tool_calls_failed || 0));
    const normalized = {
      agent_id: row.agent_id,
      skill_id: row.skill_id,
      skill_name: row.skill_id,
      total_executions: totalExecutions,
      success_count: successCount,
      failure_count: failureCount,
      partial_count: partialCount,
      success_rate: totalExecutions > 0 ? successCount / totalExecutions : 0,
      avg_duration_ms: Math.max(0, Number(row.avg_duration_ms || 0)),
      tool_breakage_rate:
        toolCallsAttempted > 0 ? toolCallsFailed / toolCallsAttempted : 0,
      positive_feedback_count: Math.max(
        0,
        Math.floor(row.positive_feedback_count || 0),
      ),
      negative_feedback_count: Math.max(
        0,
        Math.floor(row.negative_feedback_count || 0),
      ),
      last_run_at: row.last_run_at,
      last_observed_at: row.last_run_at,
    };
    const qualityScore = scoreAgentSkillQuality({
      total_executions: normalized.total_executions,
      success_count: normalized.success_count,
      failure_count: normalized.failure_count,
      partial_count: normalized.partial_count,
      positive_feedback_count: normalized.positive_feedback_count,
      negative_feedback_count: normalized.negative_feedback_count,
    });
    const reliabilityScore = scoreAgentSkillReliability({
      total_executions: normalized.total_executions,
      tool_calls_attempted: toolCallsAttempted,
      tool_calls_failed: toolCallsFailed,
    });
    const timingScore = scoreAgentSkillTiming(normalized.avg_duration_ms);
    const score = scoreAgentSkillOverall({
      quality_score: qualityScore,
      reliability_score: reliabilityScore,
      timing_score: timingScore,
    });
    return {
      ...normalized,
      actor: { type: 'agent', id: normalized.agent_id },
      quality_score: qualityScore,
      reliability_score: reliabilityScore,
      timing_score: timingScore,
      score,
    };
  }

  function recomputeAgentSkillScore(input: {
    agentId: string;
    skillId: string;
  }): AgentSkillScore | null {
    const agentId = input.agentId.trim();
    const skillId = input.skillId.trim();
    if (!agentId || !skillId) return null;

    const recompute = database.transaction((): AgentSkillScore | null => {
      const aggregate = queryOne<AgentSkillScoreAggregate, [string, string]>(
        database,
        `SELECT
           agent_id,
           skill_name AS skill_id,
           SUM(CASE WHEN outcome = 'success' AND COALESCE(tool_calls_failed, 0) = 0 THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count,
           SUM(CASE WHEN outcome = 'partial' OR (outcome = 'success' AND COALESCE(tool_calls_failed, 0) > 0) THEN 1 ELSE 0 END) AS partial_count,
           COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
           MAX(created_at) AS last_run_at,
           SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
           SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
           SUM(tool_calls_attempted) AS tool_calls_attempted,
           SUM(tool_calls_failed) AS tool_calls_failed
         FROM skill_observations
         WHERE agent_id = ? AND skill_name = ?
         GROUP BY agent_id, skill_name`,
        agentId,
        skillId,
      );

      if (!aggregate) {
        database
          .prepare(
            `DELETE FROM agent_skill_scores
           WHERE agent_id = ? AND skill_id = ?`,
          )
          .run(agentId, skillId);
        return null;
      }

      const score = mapAgentSkillScoreRow(aggregate);
      database
        .prepare(
          `INSERT INTO agent_skill_scores (
           agent_id,
           skill_id,
           success_count,
           failure_count,
           partial_count,
           avg_duration_ms,
           last_run_at,
           quality_score,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(agent_id, skill_id) DO UPDATE SET
           success_count = excluded.success_count,
           failure_count = excluded.failure_count,
           partial_count = excluded.partial_count,
           avg_duration_ms = excluded.avg_duration_ms,
           last_run_at = excluded.last_run_at,
           quality_score = excluded.quality_score,
           updated_at = excluded.updated_at`,
        )
        .run(
          score.agent_id,
          score.skill_id,
          score.success_count,
          score.failure_count,
          score.partial_count,
          score.avg_duration_ms,
          score.last_run_at,
          score.quality_score,
        );
      return score;
    });

    return recompute();
  }

  function getAgentSkillScores(params?: {
    agentId?: string;
    skillName?: string;
    skillNames?: string[];
    createdAfter?: string | null;
    limit?: number;
  }): AgentSkillScore[] {
    const clauses = [
      'score.agent_id IS NOT NULL',
      "TRIM(score.agent_id) != ''",
    ];
    const args: Array<string | number> = [];
    const agentId = params?.agentId?.trim() || '';
    const skillName = params?.skillName?.trim() || '';
    const skillNames = [
      ...new Set(
        (params?.skillNames || []).map((value) => value.trim()).filter(Boolean),
      ),
    ].sort();
    const createdAfter = params?.createdAfter?.trim() || '';
    if (agentId) {
      clauses.push('score.agent_id = ?');
      args.push(agentId);
    }
    if (skillName) {
      clauses.push('score.skill_id = ?');
      args.push(skillName);
    } else if (skillNames.length > 0) {
      clauses.push(
        `score.skill_id IN (${skillNames.map(() => '?').join(', ')})`,
      );
      args.push(...skillNames);
    }
    if (createdAfter) {
      clauses.push('score.last_run_at >= ?');
      args.push(createdAfter);
    }
    const limit =
      params?.limit == null ? null : Math.max(1, Math.min(params.limit, 2_000));
    const rows = queryAll<AgentSkillScoreAggregate, Array<string | number>>(
      database,
      `SELECT
         score.agent_id,
         score.skill_id,
         score.success_count,
         score.failure_count,
         score.partial_count,
         score.avg_duration_ms,
         score.last_run_at,
         COALESCE(feedback.positive_feedback_count, 0) AS positive_feedback_count,
         COALESCE(feedback.negative_feedback_count, 0) AS negative_feedback_count,
         COALESCE(feedback.tool_calls_attempted, 0) AS tool_calls_attempted,
         COALESCE(feedback.tool_calls_failed, 0) AS tool_calls_failed
       FROM agent_skill_scores score
       LEFT JOIN (
         SELECT
           agent_id,
           skill_name,
           SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
           SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
           SUM(tool_calls_attempted) AS tool_calls_attempted,
           SUM(tool_calls_failed) AS tool_calls_failed
         FROM skill_observations
         GROUP BY agent_id, skill_name
       ) feedback
         ON feedback.agent_id = score.agent_id
        AND feedback.skill_name = score.skill_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY score.last_run_at DESC, score.agent_id ASC, score.skill_id ASC`,
      ...args,
    );

    const sorted = rows
      .map(mapAgentSkillScoreRow)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.total_executions - left.total_executions ||
          left.agent_id.localeCompare(right.agent_id) ||
          left.skill_id.localeCompare(right.skill_id),
      );
    return limit == null ? sorted : sorted.slice(0, limit);
  }

  return { recomputeAgentSkillScore, getAgentSkillScores };
}

type SkillScoreStore = ReturnType<typeof createSkillScoreStore>;
const skillScoreStores = new WeakMap<Database.Database, SkillScoreStore>();

function withSkillScoreStore<T>(operation: (store: SkillScoreStore) => T): T {
  return withMemoryDatabase((database) => {
    let store = skillScoreStores.get(database);
    if (!store) {
      store = createSkillScoreStore(database);
      skillScoreStores.set(database, store);
    }
    return operation(store);
  });
}

export function recomputeAgentSkillScore(input: {
  agentId: string;
  skillId: string;
}): AgentSkillScore | null {
  return withSkillScoreStore((store) => store.recomputeAgentSkillScore(input));
}

export function getAgentSkillScores(params?: {
  agentId?: string;
  skillName?: string;
  skillNames?: string[];
  createdAfter?: string | null;
  limit?: number;
}): AgentSkillScore[] {
  return withSkillScoreStore((store) => store.getAgentSkillScores(params));
}
