import type {
  SkillAmendment,
  SkillHealthMetrics,
  SkillObservation,
} from './adaptive-skills-types.js';

export function formatRatioAsPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatSkillHealthMetrics(
  metrics: SkillHealthMetrics,
  options: { errorClusterLayout?: 'inline' | 'expanded' } = {},
): string {
  const lines = [
    `Skill: ${metrics.skill_name}`,
    `Executions: ${metrics.total_executions}`,
    `Success rate: ${formatRatioAsPercent(metrics.success_rate)}`,
    `Avg duration: ${Math.round(metrics.avg_duration_ms)}ms`,
    `Tool breakage: ${formatRatioAsPercent(metrics.tool_breakage_rate)}`,
    `Positive feedback: ${metrics.positive_feedback_count}`,
    `Negative feedback: ${metrics.negative_feedback_count}`,
    `Degraded: ${metrics.degraded ? 'yes' : 'no'}`,
  ];
  if (metrics.degradation_reasons.length > 0) {
    lines.push(`Reasons: ${metrics.degradation_reasons.join('; ')}`);
  }
  if (metrics.error_clusters.length > 0) {
    if (options.errorClusterLayout === 'expanded') {
      lines.push('Error clusters:');
      for (const cluster of metrics.error_clusters) {
        const sample = cluster.sample_detail
          ? ` \u2014 ${cluster.sample_detail}`
          : '';
        lines.push(`  ${cluster.category}: ${cluster.count}${sample}`);
      }
    } else {
      lines.push(
        `Error clusters: ${metrics.error_clusters
          .map((cluster) =>
            cluster.sample_detail
              ? `${cluster.category}=${cluster.count} (${cluster.sample_detail})`
              : `${cluster.category}=${cluster.count}`,
          )
          .join('; ')}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatSkillAmendment(
  amendment: SkillAmendment,
  options: { style?: 'detailed' | 'compact' } = {},
): string {
  const style = options.style ?? 'detailed';
  const lines =
    style === 'compact'
      ? [
          `v${amendment.version} [${amendment.status}] guard=${amendment.guard_verdict}/${amendment.guard_findings_count} runs=${amendment.runs_since_apply}`,
          `  created: ${amendment.created_at}`,
        ]
      : [
          `Version: ${amendment.version}`,
          `Status: ${amendment.status}`,
          `Guard: ${amendment.guard_verdict} (${amendment.guard_findings_count} finding(s))`,
          `Runs since apply: ${amendment.runs_since_apply}`,
          `Created: ${amendment.created_at}`,
        ];
  if (amendment.reviewed_by) {
    lines.push(
      style === 'compact'
        ? `  reviewed by: ${amendment.reviewed_by}`
        : `Reviewed by: ${amendment.reviewed_by}`,
    );
  }
  if (amendment.rationale) {
    lines.push(
      style === 'compact'
        ? `  rationale: ${amendment.rationale}`
        : `Rationale: ${amendment.rationale}`,
    );
  }
  if (amendment.diff_summary) {
    lines.push(
      style === 'compact'
        ? `  diff: ${amendment.diff_summary}`
        : `Diff: ${amendment.diff_summary}`,
    );
  }
  return lines.join('\n');
}

export function formatSkillObservationRun(
  observation: SkillObservation,
): string {
  const lines = [
    `Run: ${observation.run_id}`,
    `Outcome: ${observation.outcome}`,
    `Observed: ${observation.created_at}`,
    `Duration: ${observation.duration_ms}ms`,
    `Tools: ${observation.tool_calls_failed}/${observation.tool_calls_attempted} failed`,
  ];
  if (observation.feedback_sentiment) {
    lines.push(`Feedback: ${observation.feedback_sentiment}`);
  }
  if (observation.user_feedback) {
    lines.push(`Feedback note: ${observation.user_feedback}`);
  }
  if (observation.error_category) {
    lines.push(`Error category: ${observation.error_category}`);
  }
  if (observation.error_detail) {
    lines.push(`Error detail: ${observation.error_detail}`);
  }
  return lines.join('\n');
}
