import { logger } from '../logger.js';
import { redactSecretsDeep } from '../security/redact.js';
import type { ToolExecution } from '../types/execution.js';
import type { TokenUsageStats } from '../types/usage.js';
import type {
  SkillErrorCategory,
  SkillExecutionOutcome,
} from './adaptive-skills-types.js';

export interface SkillRunTokenEnvelope {
  prompt: number;
  completion: number;
  total: number;
  modelCalls: number;
  apiUsageAvailable: boolean;
  estimatedPrompt: number;
  estimatedCompletion: number;
  estimatedTotal: number;
  apiPrompt: number;
  apiCompletion: number;
  apiTotal: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface SkillRunBoundedPayload {
  content: string;
  truncated: boolean;
}

export interface SkillRunToolExecutionSummary {
  name: string;
  duration_ms: number;
  is_error: boolean;
  blocked: boolean;
  approval_tier?: ToolExecution['approvalTier'];
  approval_decision?: ToolExecution['approvalDecision'];
}

export interface SkillRunEvent {
  type: 'skill_run';
  skill_id: string;
  agent_id: string | null;
  session_id: string;
  run_id: string;
  input: SkillRunBoundedPayload | null;
  output: SkillRunBoundedPayload | null;
  model: string | null;
  tokens: SkillRunTokenEnvelope;
  latency_ms: number;
  cost_usd: number;
  errors: string[];
  outcome: SkillExecutionOutcome;
  error_category: SkillErrorCategory | null;
  error_detail: string | null;
  tool_executions: SkillRunToolExecutionSummary[];
}

export type SkillRunSubscriber = (event: SkillRunEvent) => unknown;

const subscribers = new Set<SkillRunSubscriber>();
const MAX_SKILL_RUN_PAYLOAD_CHARS = 4096;

export function subscribeSkillRunEvents(
  subscriber: SkillRunSubscriber,
): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function summarizeSkillRunToolExecutions(
  toolExecutions: ToolExecution[],
): SkillRunToolExecutionSummary[] {
  return toolExecutions.map((execution) => {
    return {
      name: execution.name,
      duration_ms: execution.durationMs,
      is_error: Boolean(execution.isError),
      blocked: Boolean(execution.blocked),
      ...(execution.approvalTier
        ? { approval_tier: execution.approvalTier }
        : {}),
      ...(execution.approvalDecision
        ? { approval_decision: execution.approvalDecision }
        : {}),
    };
  });
}

function stringifySkillRunPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function buildSkillRunBoundedPayload(
  value: unknown,
): SkillRunBoundedPayload | null {
  if (value == null) return null;
  const redacted = redactSecretsDeep(value);
  const content = stringifySkillRunPayload(redacted);
  if (content.length <= MAX_SKILL_RUN_PAYLOAD_CHARS) {
    return { content, truncated: false };
  }
  return {
    content: `${content.slice(0, MAX_SKILL_RUN_PAYLOAD_CHARS)}...`,
    truncated: true,
  };
}

export function emitSkillRunEvent(event: SkillRunEvent): void {
  let subscriberIndex = 0;
  for (const subscriber of subscribers) {
    subscriberIndex += 1;
    try {
      subscriber(event);
    } catch (error) {
      logger.warn(
        {
          sessionId: event.session_id,
          runId: event.run_id,
          skillId: event.skill_id,
          subscriberIndex,
          error,
        },
        'Skill run subscriber failed',
      );
    }
  }
}

function normalizeSkillRunModelCalls(tokenUsage?: TokenUsageStats): number {
  if (!tokenUsage) return 0;
  if (tokenUsage.modelCalls >= 1) return tokenUsage.modelCalls;
  logger.warn(
    { modelCalls: tokenUsage.modelCalls },
    'Invalid token usage model call count for skill run event',
  );
  return Math.max(0, tokenUsage.modelCalls);
}

export function buildSkillRunTokens(
  tokenUsage?: TokenUsageStats,
): SkillRunTokenEnvelope {
  const apiUsageAvailable = tokenUsage?.apiUsageAvailable === true;
  const apiPrompt = tokenUsage?.apiPromptTokens || 0;
  const apiCompletion = tokenUsage?.apiCompletionTokens || 0;
  const apiTotal = tokenUsage?.apiTotalTokens || apiPrompt + apiCompletion;
  const estimatedPrompt = tokenUsage?.estimatedPromptTokens || 0;
  const estimatedCompletion = tokenUsage?.estimatedCompletionTokens || 0;
  const estimatedTotal =
    tokenUsage?.estimatedTotalTokens || estimatedPrompt + estimatedCompletion;
  return {
    prompt: apiUsageAvailable ? apiPrompt : estimatedPrompt,
    completion: apiUsageAvailable ? apiCompletion : estimatedCompletion,
    total: apiUsageAvailable ? apiTotal : estimatedTotal,
    modelCalls: normalizeSkillRunModelCalls(tokenUsage),
    apiUsageAvailable,
    estimatedPrompt,
    estimatedCompletion,
    estimatedTotal,
    apiPrompt,
    apiCompletion,
    apiTotal,
    ...(tokenUsage?.apiCacheUsageAvailable
      ? {
          cacheRead: tokenUsage.apiCacheReadTokens || 0,
          cacheWrite: tokenUsage.apiCacheWriteTokens || 0,
        }
      : {}),
  };
}
