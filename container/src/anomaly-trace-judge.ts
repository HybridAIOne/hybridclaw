import type { ToolApprovalEvaluation } from './approval-policy.js';
import {
  type AuxiliaryTaskContext,
  callAuxiliaryModel,
} from './providers/auxiliary.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  TaskModelPolicies,
} from './types.js';

export type AnomalyTraceJudgeVerdict =
  | 'normal'
  | 'anomalous'
  | 'inconclusive'
  | 'error';

export interface AnomalyTraceJudgeResult {
  verdict: AnomalyTraceJudgeVerdict;
  score: number | null;
  reason: string;
}

export interface ResolvedAnomalyApproval {
  evaluation: ToolApprovalEvaluation;
  response?: ChatCompletionResponse;
}

type AnomalyTraceJudgeCaller = typeof callAuxiliaryModel;

const SENSITIVE_ARG_KEY_RE =
  /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|session)/i;

function sanitizeTraceJudgeArguments(
  toolName: string,
  value: unknown,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTraceJudgeArguments(toolName, entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_ARG_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (toolName === 'browser_type' && key === 'text') {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeTraceJudgeArguments(toolName, raw);
  }
  return out;
}

function sanitizeTraceJudgeArgsJson(
  toolName: string,
  argsJson: string,
): string {
  try {
    return JSON.stringify(
      sanitizeTraceJudgeArguments(toolName, JSON.parse(argsJson) as unknown),
    );
  } catch {
    return JSON.stringify({
      _redacted: 'unparseable tool arguments omitted from trace judge input',
    });
  }
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('trace judge returned empty content');
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Continue with fenced/embedded JSON extraction.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue with embedded JSON extraction.
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to the final shape error.
    }
  }
  throw new Error('trace judge did not return a JSON object');
}

function normalizeJudgeScore(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

export function parseAnomalyTraceJudgeResult(
  content: string,
): AnomalyTraceJudgeResult {
  const payload = extractJsonObject(content);
  const normalizedVerdict = String(payload.verdict || '')
    .trim()
    .toLowerCase();
  const verdict: AnomalyTraceJudgeVerdict =
    normalizedVerdict === 'anomalous' ||
    normalizedVerdict === 'normal' ||
    normalizedVerdict === 'inconclusive'
      ? normalizedVerdict
      : 'inconclusive';
  const reason = String(payload.reasoning || payload.reason || '').trim();
  return {
    verdict,
    score: normalizeJudgeScore(payload.score),
    reason: reason || 'trace judge returned no reasoning',
  };
}

function buildTraceJudgeMessages(input: {
  evaluation: ToolApprovalEvaluation;
  toolName: string;
  argsJson: string;
  latestUserPrompt: string;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are F11 trace-judge for HybridClaw tool authorization.',
        'Review a borderline behavioral anomaly score and decide whether the tool call is unusual enough to elevate the safety tier by one level.',
        'Return only JSON: {"verdict":"normal|anomalous|inconclusive","score":0..1,"reasoning":"short reason"}.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        criteria:
          'Mark anomalous only when the proposed tool call is meaningfully inconsistent with the agent baseline and should receive a one-tier approval elevation.',
        latestUserPrompt: input.latestUserPrompt,
        toolName: input.toolName,
        argsJson: input.argsJson,
        approval: {
          actionKey: input.evaluation.actionKey,
          baseTier: input.evaluation.baseTier,
          tier: input.evaluation.tier,
          intent: input.evaluation.intent,
          reason: input.evaluation.reason,
          commandPreview: input.evaluation.commandPreview,
          stakes: input.evaluation.stakes,
          anomaly: input.evaluation.anomaly,
        },
      }),
    },
  ];
}

function withTraceJudgeResult(
  evaluation: ToolApprovalEvaluation,
  result: AnomalyTraceJudgeResult,
): ToolApprovalEvaluation {
  const anomaly = evaluation.anomaly
    ? {
        ...evaluation.anomaly,
        traceJudge: result,
        reason: `${evaluation.anomaly.reason}; F11 trace-judge ${result.verdict}: ${result.reason}`,
      }
    : undefined;
  return anomaly ? { ...evaluation, anomaly } : evaluation;
}

export async function resolveBorderlineAnomalyWithTraceJudge(input: {
  evaluation: ToolApprovalEvaluation;
  toolName: string;
  argsJson: string;
  latestUserPrompt: string;
  taskModels?: TaskModelPolicies;
  fallbackContext: AuxiliaryTaskContext;
  caller?: AnomalyTraceJudgeCaller;
}): Promise<ResolvedAnomalyApproval> {
  const anomaly = input.evaluation.anomaly;
  if (anomaly?.status !== 'borderline') {
    return { evaluation: input.evaluation };
  }

  try {
    const caller = input.caller || callAuxiliaryModel;
    const sanitizedInput = {
      ...input,
      argsJson: sanitizeTraceJudgeArgsJson(input.toolName, input.argsJson),
    };
    const response = await caller({
      task: 'eval_judge',
      taskModels: input.taskModels,
      fallbackContext: input.fallbackContext,
      messages: buildTraceJudgeMessages(sanitizedInput),
      maxTokens: 300,
      toolName: 'f11_trace_judge',
    });
    const result = parseAnomalyTraceJudgeResult(response.content);
    return {
      evaluation: withTraceJudgeResult(input.evaluation, result),
      response: response.response,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      evaluation: withTraceJudgeResult(input.evaluation, {
        verdict: 'error',
        score: null,
        reason,
      }),
    };
  }
}
