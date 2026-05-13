import { randomUUID } from 'node:crypto';
import {
  type GoalJudgeEvent,
  registerGoalJudgeSubscriber,
} from '../evals/judge-subscriber.js';
import { isDatabaseInitialized } from '../memory/db.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { estimateTokenCountFromMessages } from '../session/token-efficiency.js';
import { emitRuntimeEvent } from '../skills/skill-run-events.js';
import type { ChatMessage } from '../types/api.js';
import {
  enqueueTokenUsage,
  flushTokenUsageBuffer,
} from '../usage/token-usage-buffer.js';

export interface GoalJudgeVerdict {
  done: boolean;
  reason: string;
}

export interface GoalJudgeResult extends GoalJudgeVerdict {
  parseFailure: boolean;
}

export interface GoalJudgeModelCallParams {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface GoalJudgeModelCallResponse {
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
  modelCaller?: (
    params: GoalJudgeModelCallParams,
  ) => Promise<GoalJudgeModelCallResponse>;
}

const GOAL_JUDGE_MAX_TOKENS = 200;
const GOAL_JUDGE_TIMEOUT_MS = 30_000;
const GOAL_JUDGE_SUBSCRIBER_TIMEOUT_MS = 35_000;

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
        'Return only strict JSON with this shape: {"done": true|false, "reason": "..."}',
        'Be conservative: if there is any meaningful next step, set done to false.',
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
  await flushTokenUsageBuffer();
}

async function judgeGoalCompletionDirect(
  params: JudgeGoalCompletionParams,
): Promise<GoalJudgeResult> {
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
      : await callAuxiliaryModel({
          task: 'goal_judge',
          messages,
          maxTokens: GOAL_JUDGE_MAX_TOKENS,
          temperature: 0,
          timeoutMs: GOAL_JUDGE_TIMEOUT_MS,
          extraBody: {
            response_format: { type: 'json_object' },
          },
        });
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
  registerGoalJudgeSubscriber({
    id: GOAL_JUDGE_SUBSCRIBER_ID,
    debounceMs: 0,
    maxQueueSize: 100,
    sink: async ({ event }) => {
      const result = await judgeGoalCompletionDirect({
        sessionId: event.session_id,
        agentId: event.agent_id,
        threadId: event.thread_id,
        goalText: event.goal_text,
        assistantResponse: event.assistant_response,
      });
      resolveGoalJudgeRequest(event.request_id, result);
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
