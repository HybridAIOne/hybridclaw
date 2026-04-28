import type { SkillGuardVerdict } from './skills-guard.js';

export type SkillExecutionOutcome = 'success' | 'failure' | 'partial';

export type SkillErrorCategory =
  | 'tool_error'
  | 'timeout'
  | 'user_abort'
  | 'model_error'
  | 'env_changed'
  | 'unknown';

export type SkillFeedbackSentiment = 'positive' | 'negative' | 'neutral';

export type SkillAmendmentStatus =
  | 'staged'
  | 'applied'
  | 'rolled_back'
  | 'rejected';

export interface SkillErrorCluster {
  category: SkillErrorCategory;
  count: number;
  sample_detail?: string | null;
}

export interface SkillObservation {
  id: number;
  skill_name: string;
  agent_id: string | null;
  session_id: string;
  run_id: string;
  outcome: SkillExecutionOutcome;
  error_category: SkillErrorCategory | null;
  error_detail: string | null;
  tool_calls_attempted: number;
  tool_calls_failed: number;
  duration_ms: number;
  user_feedback: string | null;
  feedback_sentiment: SkillFeedbackSentiment | null;
  created_at: string;
}

export interface SkillObservationSummary {
  skill_name: string;
  total_executions: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  avg_duration_ms: number;
  tool_calls_attempted: number;
  tool_calls_failed: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
  error_clusters: SkillErrorCluster[];
  last_observed_at: string | null;
}

export interface AgentSkillScore {
  agent_id: string;
  skill_id: string;
  skill_name: string;
  total_executions: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  success_rate: number;
  avg_duration_ms: number;
  tool_breakage_rate: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
  last_run_at: string | null;
  quality_score: number;
  reliability_score: number;
  timing_score: number;
  score: number;
  last_observed_at: string | null;
}

export interface AgentScoreboardEntry {
  agent_id: string;
  display_name: string;
  total_executions: number;
  success_rate: number;
  avg_score: number;
  avg_quality_score: number;
  avg_reliability_score: number;
  avg_timing_score: number;
  best_skills: AgentSkillScore[];
  last_observed_at: string | null;
  cv_path: string;
}

export interface SkillHealthMetrics {
  skill_name: string;
  total_executions: number;
  success_rate: number;
  avg_duration_ms: number;
  error_clusters: SkillErrorCluster[];
  tool_breakage_rate: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
  degraded: boolean;
  degradation_reasons: string[];
  window_started_at: string;
  window_ended_at: string;
}

export interface SkillAmendment {
  id: number;
  skill_name: string;
  skill_file_path: string;
  version: number;
  previous_version: number | null;
  status: SkillAmendmentStatus;
  original_content: string;
  proposed_content: string;
  original_content_hash: string;
  proposed_content_hash: string;
  rationale: string;
  diff_summary: string;
  proposed_by: string;
  reviewed_by: string | null;
  guard_verdict: SkillGuardVerdict;
  guard_findings_count: number;
  metrics_at_proposal: SkillHealthMetrics | null;
  metrics_post_apply: SkillHealthMetrics | null;
  runs_since_apply: number;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  rolled_back_at: string | null;
  rejected_at: string | null;
}

export interface AdaptiveSkillsConfig {
  enabled: boolean;
  observationEnabled: boolean;
  trajectoryCapture: {
    enabledAgentIds: string[];
    storeDir: string;
  };
  inspectionIntervalMs: number;
  observationRetentionDays: number;
  trailingWindowHours: number;
  minExecutionsForInspection: number;
  degradationSuccessRateThreshold: number;
  degradationToolBreakageThreshold: number;
  autoApplyEnabled: boolean;
  evaluationRunsBeforeRollback: number;
  rollbackImprovementThreshold: number;
}
