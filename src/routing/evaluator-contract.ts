/**
 * Closed evaluator vocabulary shared by providers, policy, and presentation.
 * Probabilities are evidence, never permission to disclose input or execute tools.
 * No prompt content belongs in an evaluation record.
 */
export const EVALUATION_LABELS = {
  pii: ['absent', 'present', 'uncertain'],
  confidentiality: ['public', 'confidential', 'uncertain'],
  capability: ['basic', 'standard', 'advanced', 'uncertain'],
  urgency: ['urgent', 'normal', 'relaxed', 'unspecified'],
} as const;
export type EvaluationDimension = keyof typeof EVALUATION_LABELS;
export interface ChoiceDistribution {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface TypedRoutingEvaluation {
  version: 1;
  provider: string;
  mode: 'shadow' | 'active';
  status: 'evaluated' | 'blocked' | 'fallback';
  reason: string;
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  distributions: Record<EvaluationDimension, ChoiceDistribution> | null;
  recommendedTier: string | null;
  capability?: 'basic' | 'standard' | 'advanced' | 'uncertain';
  urgency?: 'urgent' | 'normal' | 'relaxed' | 'unspecified';
  selectedModel?: string | null;
  applied: boolean;
}
export interface RoutingEvaluatorConfig {
  mode: 'off' | 'shadow' | 'active';
  model: string;
  timeoutMs: number;
  minConfidence: number;
  publicPrompts: string[];
}
// Phase 2 product defaults (2026-09-21): opt-in, bounded overhead, conservative
// confidence. Calibration and learned thresholds are deferred to model evaluation.
export const DEFAULT_ROUTING_EVALUATOR: RoutingEvaluatorConfig = {
  mode: 'off',
  model: 'jev-latest',
  timeoutMs: 1500,
  minConfidence: 0.8,
  publicPrompts: [],
};
export function normalizeRoutingEvaluator(
  value: unknown,
): RoutingEvaluatorConfig {
  if (value === undefined) return structuredClone(DEFAULT_ROUTING_EVALUATOR);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('routing.evaluator must be an object.');
  const raw = { ...DEFAULT_ROUTING_EVALUATOR, ...value };
  if (
    !['off', 'shadow', 'active'].includes(raw.mode) ||
    typeof raw.model !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(raw.model) ||
    !Number.isInteger(raw.timeoutMs) ||
    raw.timeoutMs < 100 ||
    raw.timeoutMs > 10000 ||
    !Number.isFinite(raw.minConfidence) ||
    raw.minConfidence < 0 ||
    raw.minConfidence > 1 ||
    !Array.isArray(raw.publicPrompts) ||
    raw.publicPrompts.length > 100 ||
    raw.publicPrompts.some(
      (p) => typeof p !== 'string' || !p.trim() || p.length > 4000,
    )
  ) {
    throw new Error(
      'Invalid routing evaluator settings: mode, model, timeout (100–10000ms), confidence (0–1), or public prompts.',
    );
  }
  return {
    mode: raw.mode,
    model: raw.model,
    timeoutMs: raw.timeoutMs,
    minConfidence: raw.minConfidence,
    publicPrompts: [...new Set(raw.publicPrompts.map((p) => p.trim()))],
  };
}

export function isTypedRoutingEvaluation(
  value: unknown,
): value is TypedRoutingEvaluation {
  if (!value || typeof value !== 'object') return false;
  const v = value as TypedRoutingEvaluation;
  if (
    v.version !== 1 ||
    typeof v.provider !== 'string' ||
    !/^[a-z0-9-]{1,40}$/.test(v.provider) ||
    !['shadow', 'active'].includes(v.mode) ||
    !['evaluated', 'blocked', 'fallback'].includes(v.status) ||
    typeof v.applied !== 'boolean' ||
    typeof v.reason !== 'string' ||
    v.reason.length > 100 ||
    typeof v.model !== 'string' ||
    v.model.length > 100 ||
    !Number.isFinite(v.durationMs) ||
    v.durationMs < 0 ||
    (v.recommendedTier !== null && typeof v.recommendedTier !== 'string')
  )
    return false;
  if (
    v.capability !== undefined &&
    !EVALUATION_LABELS.capability.includes(v.capability)
  )
    return false;
  if (v.urgency !== undefined && !EVALUATION_LABELS.urgency.includes(v.urgency))
    return false;
  if (
    v.selectedModel != null &&
    (typeof v.selectedModel !== 'string' || v.selectedModel.length > 300)
  )
    return false;
  for (const n of [v.inputTokens, v.outputTokens, v.costUsd])
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0))
      return false;
  if (v.distributions === null) return true;
  if (!v.distributions || typeof v.distributions !== 'object') return false;
  for (const key of Object.keys(EVALUATION_LABELS) as EvaluationDimension[]) {
    const d = v.distributions[key];
    const labels: readonly string[] = EVALUATION_LABELS[key];
    if (
      !d ||
      !labels.includes(d.choice) ||
      !Number.isFinite(d.confidence) ||
      d.confidence < 0 ||
      d.confidence > 1 ||
      !d.probabilities ||
      Object.keys(d.probabilities).length !== labels.length
    )
      return false;
    if (
      labels.some(
        (label) =>
          !Number.isFinite(d.probabilities[label]) ||
          d.probabilities[label] < 0 ||
          d.probabilities[label] > 1,
      )
    )
      return false;
    if (
      Math.abs(Object.values(d.probabilities).reduce((a, b) => a + b, 0) - 1) >
      0.001
    )
      return false;
  }
  return true;
}
