import { randomUUID } from 'node:crypto';
import {
  type GoalJudgeEvent,
  registerJudgeSubscriber,
} from '../evals/judge-subscriber.js';
import { isDatabaseInitialized } from '../memory/db.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { estimateTokenCountFromMessages } from '../session/token-efficiency.js';
import { emitRuntimeEvent } from '../skills/skill-run-events.js';
import type { ChatMessage } from '../types/api.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';

export interface GoalJudgeVerdict {
  done: boolean;
  reason: string;
}

export interface GoalJudgeResult extends GoalJudgeVerdict {
  parseFailure: boolean;
}

interface GoalJudgeModelCallParams {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

interface GoalJudgeModelCallResponse {
  content: string;
  model?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  } | null;
}

export interface JudgeGoalCompletionParams {
  sessionId: string;
  agentId: string;
  threadId?: string | null;
  goalText: string;
  assistantResponse: string;
  fallbackModel?: string | null;
  /** @internal Test injection only. Production callers should use the configured goal_judge model. */
  modelCaller?: (
    params: GoalJudgeModelCallParams,
  ) => Promise<GoalJudgeModelCallResponse>;
}

const GOAL_JUDGE_MAX_TOKENS = 400;
const GOAL_JUDGE_TIMEOUT_MS = 30_000;
const GOAL_JUDGE_SUBSCRIBER_TIMEOUT_MS = 35_000;
const GOAL_JUDGE_STRUCTURED_BODY = {
  response_format: { type: 'json_object' },
};

export const GOAL_JUDGE_SUBSCRIBER_ID = 'goal_judge';

const pendingGoalJudgeRequests = new Map<
  string,
  {
    resolve: (result: GoalJudgeResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let goalJudgeSubscriberRegistered = false;

function buildGoalJudgeMessages(params: {
  goalText: string;
  assistantResponse: string;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You judge whether an assistant has completed a standing user goal.',
        '/no_think',
        'Return only strict JSON with this shape: {"done": true|false, "reason": "..."}',
        'Output exactly one JSON object and no prose, markdown, code fences, or hidden reasoning.',
        'Be conservative: if there is any meaningful next step, set done to false.',
        'Do not return done true until every explicit completion condition in the goal is satisfied.',
        'If the latest response is an intermediate numbered or counting step and the goal names a later final step, set done to false.',
        'If the latest response reaches the requested final step and explicitly says the goal is complete, set done to true.',
        'Do not mark the goal done only because the assistant says it will continue later or is blocked.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        goal: params.goalText,
        latest_assistant_response: params.assistantResponse,
      }),
    },
  ];
}

function inferExplicitGoalCompletion(
  assistantResponse: string,
): GoalJudgeResult | null {
  const normalized = assistantResponse
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  if (
    /\b(?:the\s+)?goal\s+(?:is\s+)?(?:already\s+)?completed?\b/.test(normalized)
  ) {
    return {
      done: true,
      reason: 'assistant explicitly stated the goal is complete',
      parseFailure: false,
    };
  }
  return null;
}

function inferCountingGoalProgress(params: {
  goalText: string;
  assistantResponse: string;
}): GoalJudgeResult | null {
  const goalMatch = /\bcount\s+from\s+(-?\d+)\s+to\s+(-?\d+)\b/i.exec(
    params.goalText,
  );
  if (!goalMatch) return null;

  const start = Number(goalMatch[1]);
  const target = Number(goalMatch[2]);
  if (!Number.isFinite(start) || !Number.isFinite(target) || start === target) {
    return null;
  }

  const numbers = Array.from(
    params.assistantResponse.matchAll(/(?<![\w.-])-?\d+(?![\w.-])/g),
    (match) => Number(match[0]),
  ).filter((value) => Number.isFinite(value));
  const latestNumber = numbers.at(-1);
  if (latestNumber === undefined) return null;

  const isAscending = target > start;
  const stillInProgress = isAscending
    ? latestNumber < target
    : latestNumber > target;
  if (!stillInProgress) return null;

  return {
    done: false,
    reason: `count has reached ${latestNumber}, target is ${target}`,
    parseFailure: false,
  };
}

export function parseGoalJudgeVerdict(content: string): GoalJudgeVerdict {
  const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
  if (typeof parsed.done !== 'boolean') {
    throw new Error('Goal judge verdict is missing boolean `done`.');
  }
  const reason = String(parsed.reason || '').trim();
  if (!reason) {
    throw new Error('Goal judge verdict is missing non-empty `reason`.');
  }
  return {
    done: parsed.done,
    reason: reason.slice(0, 1_000),
  };
}

function usageTokenCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function usageCostUsd(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

async function recordGoalJudgeUsage(params: {
  sessionId: string;
  agentId: string;
  model: string;
  messages: ChatMessage[];
  response: GoalJudgeModelCallResponse;
}): Promise<void> {
  if (!isDatabaseInitialized()) return;
  const inputTokens =
    usageTokenCount(params.response.usage?.inputTokens) ??
    estimateTokenCountFromMessages(params.messages);
  const outputTokens =
    usageTokenCount(params.response.usage?.outputTokens) ?? 0;
  const totalTokens =
    usageTokenCount(params.response.usage?.totalTokens) ??
    inputTokens + outputTokens;
  enqueueTokenUsage({
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: params.model,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: usageCostUsd(params.response.usage?.costUsd) ?? 0,
  });
}

function isEmptyGoalJudgeResponseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('goal_judge returned an empty response');
}

async function callGoalJudgeAuxiliaryModel(
  messages: ChatMessage[],
  fallbackModel?: string | null,
): Promise<GoalJudgeModelCallResponse> {
  try {
    return await callAuxiliaryModel({
      task: 'goal_judge',
      messages,
      fallbackModel: fallbackModel?.trim() || undefined,
      maxTokens: GOAL_JUDGE_MAX_TOKENS,
      temperature: 0,
      timeoutMs: GOAL_JUDGE_TIMEOUT_MS,
      extraBody: GOAL_JUDGE_STRUCTURED_BODY,
    });
  } catch (error) {
    if (!isEmptyGoalJudgeResponseError(error)) throw error;
    return await callAuxiliaryModel({
      task: 'goal_judge',
      messages,
      fallbackModel: fallbackModel?.trim() || undefined,
      maxTokens: GOAL_JUDGE_MAX_TOKENS,
      temperature: 0,
      timeoutMs: GOAL_JUDGE_TIMEOUT_MS,
    });
  }
}

async function judgeGoalCompletionDirect(
  params: JudgeGoalCompletionParams,
): Promise<GoalJudgeResult> {
  const countingProgress = inferCountingGoalProgress({
    goalText: params.goalText,
    assistantResponse: params.assistantResponse,
  });
  if (countingProgress) return countingProgress;

  const explicitCompletion = inferExplicitGoalCompletion(
    params.assistantResponse,
  );
  if (explicitCompletion) return explicitCompletion;

  const messages = buildGoalJudgeMessages({
    goalText: params.goalText,
    assistantResponse: params.assistantResponse,
  });

  try {
    const response = params.modelCaller
      ? await params.modelCaller({
          messages,
          maxTokens: GOAL_JUDGE_MAX_TOKENS,
          temperature: 0,
          timeoutMs: GOAL_JUDGE_TIMEOUT_MS,
        })
      : await callGoalJudgeAuxiliaryModel(messages, params.fallbackModel);
    try {
      await recordGoalJudgeUsage({
        sessionId: params.sessionId,
        agentId: params.agentId,
        model: response.model?.trim() || 'goal_judge',
        messages,
        response,
      });
    } catch {
      // Usage accounting should not make the judge declare a goal complete.
    }
    return {
      ...parseGoalJudgeVerdict(response.content),
      parseFailure: false,
    };
  } catch (error) {
    return {
      done: false,
      reason: error instanceof Error ? error.message : String(error),
      parseFailure: true,
    };
  }
}

function resolveGoalJudgeRequest(
  requestId: string,
  result: GoalJudgeResult,
): void {
  const pending = pendingGoalJudgeRequests.get(requestId);
  if (!pending) return;
  pendingGoalJudgeRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

export function ensureGoalJudgeSubscriberRegistered(): void {
  if (goalJudgeSubscriberRegistered) return;
  goalJudgeSubscriberRegistered = true;
  registerJudgeSubscriber({
    id: GOAL_JUDGE_SUBSCRIBER_ID,
    runtimeEventType: 'goal_judge',
    debounceMs: 0,
    maxQueueSize: 100,
    runtimeSink: async ({ event }) => {
      const goalEvent = event as GoalJudgeEvent;
      const result = await judgeGoalCompletionDirect({
        sessionId: goalEvent.session_id,
        agentId: goalEvent.agent_id,
        threadId: goalEvent.thread_id,
        goalText: goalEvent.goal_text,
        assistantResponse: goalEvent.assistant_response,
        fallbackModel: goalEvent.fallback_model,
      });
      resolveGoalJudgeRequest(goalEvent.request_id, result);
    },
  });
}

export async function judgeGoalCompletion(
  params: JudgeGoalCompletionParams,
): Promise<GoalJudgeResult> {
  if (params.modelCaller) {
    return judgeGoalCompletionDirect(params);
  }

  ensureGoalJudgeSubscriberRegistered();
  const requestId = randomUUID();
  const event: GoalJudgeEvent = {
    type: 'goal_judge',
    request_id: requestId,
    session_id: params.sessionId,
    agent_id: params.agentId,
    thread_id: params.threadId ?? null,
    goal_text: params.goalText,
    assistant_response: params.assistantResponse,
    fallback_model: params.fallbackModel?.trim() || null,
    created_at: new Date().toISOString(),
  };

  return new Promise<GoalJudgeResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingGoalJudgeRequests.delete(requestId);
      resolve({
        done: false,
        reason: 'Goal judge subscriber timed out.',
        parseFailure: true,
      });
    }, GOAL_JUDGE_SUBSCRIBER_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    pendingGoalJudgeRequests.set(requestId, { resolve, timer });
    emitRuntimeEvent(event);
  });
}
