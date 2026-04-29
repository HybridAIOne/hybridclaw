import { getAgentById, listAgents } from '../agents/agent-registry.js';
import { getAgentSkillScores } from '../memory/db.js';
import type {
  AgentScoreboardEntry,
  AgentSkillScore,
} from './adaptive-skills-types.js';

export {
  cv,
  refreshAgentCv,
  refreshAgentCvForSkillRun,
  scheduleAgentCvRefresh,
  waitForQueuedAgentCvRefreshes,
} from './agent-cv.js';

import { cvPathForAgent, refreshAgentCv } from './agent-cv.js';
import type { SkillCatalogEntry } from './skills.js';
import { loadSkillCatalog } from './skills.js';

const AGENT_RECOMMENDATION_SCORE_CACHE_TTL_MS = 60_000;
let cachedRecommendationSkillCatalog: SkillCatalogEntry[] | null = null;
let cachedRecommendationScores: {
  expiresAt: number;
  cacheKey: string;
  scores: AgentSkillScore[];
} | null = null;

function displayNameForAgent(agentId: string): string {
  const agent = getAgentById(agentId);
  return agent?.displayName || agent?.name || agentId;
}

function displayNamesByAgentId(): Map<string, string> {
  return new Map(
    listAgents().map((agent) => [
      agent.id,
      agent.displayName || agent.name || agent.id,
    ]),
  );
}

const compareBestSkills = (left: AgentSkillScore, right: AgentSkillScore) =>
  right.score - left.score ||
  right.total_executions - left.total_executions ||
  left.skill_name.localeCompare(right.skill_name);

function summarizeScores(scores: AgentSkillScore[]): {
  totalExecutions: number;
  successRate: number;
  avgScore: number;
  avgQualityScore: number;
  avgReliabilityScore: number;
  avgTimingScore: number;
  lastObservedAt: string | null;
} {
  const totalExecutions = scores.reduce(
    (total, score) => total + score.total_executions,
    0,
  );
  const totalSuccesses = scores.reduce(
    (total, score) => total + score.success_count,
    0,
  );
  const weightedScore = scores.reduce(
    (total, score) => total + score.score * score.total_executions,
    0,
  );
  const weightedQualityScore = scores.reduce(
    (total, score) => total + score.quality_score * score.total_executions,
    0,
  );
  const weightedReliabilityScore = scores.reduce(
    (total, score) => total + score.reliability_score * score.total_executions,
    0,
  );
  const weightedTimingScore = scores.reduce(
    (total, score) => total + score.timing_score * score.total_executions,
    0,
  );
  return {
    totalExecutions,
    successRate: totalExecutions > 0 ? totalSuccesses / totalExecutions : 0,
    avgScore:
      totalExecutions > 0 ? Math.round(weightedScore / totalExecutions) : 0,
    avgQualityScore:
      totalExecutions > 0
        ? Math.round(weightedQualityScore / totalExecutions)
        : 0,
    avgReliabilityScore:
      totalExecutions > 0
        ? Math.round(weightedReliabilityScore / totalExecutions)
        : 0,
    avgTimingScore:
      totalExecutions > 0
        ? Math.round(weightedTimingScore / totalExecutions)
        : 0,
    lastObservedAt:
      scores
        .map((score) => score.last_observed_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) || null,
  };
}

export function getAgentScoreboard(): AgentScoreboardEntry[] {
  const scores = getAgentSkillScores();
  const scoresByAgent = new Map<string, AgentSkillScore[]>();
  for (const score of scores) {
    const existing = scoresByAgent.get(score.agent_id) || [];
    existing.push(score);
    scoresByAgent.set(score.agent_id, existing);
  }

  return [...scoresByAgent.entries()]
    .map(([agentId, agentScores]) => {
      const summary = summarizeScores(agentScores);
      return {
        agent_id: agentId,
        display_name: displayNameForAgent(agentId),
        total_executions: summary.totalExecutions,
        success_rate: summary.successRate,
        avg_score: summary.avgScore,
        avg_quality_score: summary.avgQualityScore,
        avg_reliability_score: summary.avgReliabilityScore,
        avg_timing_score: summary.avgTimingScore,
        best_skills: [...agentScores].sort(compareBestSkills).slice(0, 5),
        last_observed_at: summary.lastObservedAt,
        cv_path: cvPathForAgent(agentId),
      };
    })
    .sort(
      (left, right) =>
        right.avg_score - left.avg_score ||
        right.total_executions - left.total_executions ||
        left.display_name.localeCompare(right.display_name),
    );
}

export function getObservedAgentSkillCount(): number {
  return new Set(getAgentSkillScores().map((score) => score.skill_name)).size;
}

export function getBestAgentsForSkill(
  skillName: string,
  limit = 5,
): AgentSkillScore[] {
  return getAgentSkillScores({
    skillName,
    limit: Math.max(1, Math.min(limit, 25)),
  });
}

export function refreshAllAgentCvs(): string[] {
  const registeredIds = listAgents().map((agent) => agent.id);
  const observedIds = getAgentScoreboard().map((entry) => entry.agent_id);
  const ids = Array.from(new Set([...registeredIds, ...observedIds]));
  return ids
    .map((id) => refreshAgentCv(id))
    .filter((value): value is string => Boolean(value));
}

function normalizeRecommendationTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSkillForTask(params: {
  task: string;
  skillName: string;
  description: string;
  category: string;
  tags: string[];
}): number {
  const task = normalizeRecommendationTerm(params.task);
  if (!task) return 0;
  const haystack = normalizeRecommendationTerm(
    [
      params.skillName,
      params.description,
      params.category,
      ...params.tags,
    ].join(' '),
  );
  const skillName = normalizeRecommendationTerm(params.skillName);
  let score = 0;
  if (task.includes(skillName) || haystack.includes(task)) score += 10;
  for (const term of task.split(' ')) {
    if (term.length < 3) continue;
    if (skillName.includes(term)) score += 4;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function getRecommendationSkillCatalog(): SkillCatalogEntry[] {
  cachedRecommendationSkillCatalog ??= loadSkillCatalog();
  return cachedRecommendationSkillCatalog;
}

function getRecommendationAgentSkillScores(
  skillNames: string[],
  now = Date.now(),
): AgentSkillScore[] {
  const normalizedSkillNames = [
    ...new Set(skillNames.map((name) => name.trim())),
  ]
    .filter(Boolean)
    .sort();
  const cacheKey = normalizedSkillNames.join('\n');
  if (
    cachedRecommendationScores &&
    cachedRecommendationScores.cacheKey === cacheKey &&
    cachedRecommendationScores.expiresAt > now
  ) {
    return cachedRecommendationScores.scores;
  }
  const scores = getAgentSkillScores({ skillNames: normalizedSkillNames });
  cachedRecommendationScores = {
    expiresAt: now + AGENT_RECOMMENDATION_SCORE_CACHE_TTL_MS,
    cacheKey,
    scores,
  };
  return scores;
}

export function clearAgentRecommendationCache(): void {
  cachedRecommendationSkillCatalog = null;
  cachedRecommendationScores = null;
}

export interface AgentRecommendation {
  agent_id: string;
  display_name: string;
  skill_id: string;
  score: number;
  quality_score: number;
  success_rate: number;
  reliability_score: number;
  timing_score: number;
  total_executions: number;
  relevance_score: number;
  rank_score: number;
}

export function recommendAgentsFor(
  task: string,
  limit = 3,
): AgentRecommendation[] {
  const skills = getRecommendationSkillCatalog();
  const relevanceBySkill = new Map<string, number>();
  for (const skill of skills) {
    const relevance = scoreSkillForTask({
      task,
      skillName: skill.name,
      description: skill.description,
      category: skill.category,
      tags: skill.metadata.hybridclaw.tags,
    });
    if (relevance > 0) relevanceBySkill.set(skill.name, relevance);
  }

  const relevantSkillNames = [...relevanceBySkill.keys()];
  if (relevantSkillNames.length === 0) return [];

  const scores = getRecommendationAgentSkillScores(relevantSkillNames);
  const displayNames = displayNamesByAgentId();
  return scores
    .map((score) => {
      const relevance = relevanceBySkill.get(score.skill_id) || 0;
      return {
        agent_id: score.agent_id,
        display_name: displayNames.get(score.agent_id) || score.agent_id,
        skill_id: score.skill_id,
        score: score.score,
        quality_score: score.quality_score,
        success_rate: score.success_rate,
        reliability_score: score.reliability_score,
        timing_score: score.timing_score,
        total_executions: score.total_executions,
        relevance_score: relevance,
        rank_score: relevance * 100 + score.score,
      };
    })
    .filter((entry) => entry.relevance_score > 0)
    .sort(
      (left, right) =>
        right.rank_score - left.rank_score ||
        right.score - left.score ||
        right.quality_score - left.quality_score ||
        right.total_executions - left.total_executions ||
        left.display_name.localeCompare(right.display_name),
    )
    .slice(0, Math.max(1, Math.min(limit, 10)));
}

export function formatAgentAssignmentHints(task: string): string {
  const recommendations = recommendAgentsFor(task, 3);
  if (recommendations.length === 0) return '';
  return [
    '## Agent Assignment Hints',
    ...recommendations.map(
      (entry, index) =>
        `${index + 1}. ${entry.display_name} (${entry.agent_id}) for ${entry.skill_id}: ${entry.score}/100 overall, ${entry.quality_score}/100 quality, ${entry.reliability_score}/100 reliability, ${entry.timing_score}/100 timing across ${entry.total_executions} runs.`,
    ),
  ].join('\n');
}
