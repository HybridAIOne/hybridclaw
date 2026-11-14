/**
 * Request-scoped provider accounting checkpoints each actual call, not tool turns.
 * Primary and helper calls keep model identity; missing usage is never a zero bill.
 * Unlike routing context, this stores no prompts, credentials, responses or policy.
 * Closed scopes cannot amend a completed turn or charge a later worker request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readReportedUsageCost } from '@hybridclaw/shared/reported-usage-cost';
import type { ModelCallUsage } from '@hybridclaw/shared/token-usage';
import {
  IncompleteModelResponseError,
  isCompleteToolCallFinish,
} from './model-response-completion.js';
import type { NormalizedCallArgs } from './providers/shared.js';
import { WORKSPACE_ROOT, WORKSPACE_STATE_ROOT } from './runtime-paths.js';
import {
  accumulateApiUsage,
  createTokenUsageStats,
  estimateResponseTokens,
} from './token-usage.js';
import { TurnToolHistory } from './turn-tool-history.js';
import type { ChatCompletionResponse, ContainerInput } from './types.js';

const scope = new AsyncLocalStorage<{
  owner: { history: TurnToolHistory; closed: boolean };
  task?: string;
}>();

export function createRequestTurnHistory(
  input: ContainerInput,
): TurnToolHistory {
  return new TurnToolHistory(
    input.sessionId,
    WORKSPACE_STATE_ROOT,
    WORKSPACE_ROOT,
    input.runId || input.requestId || randomUUID(),
  );
}

export async function withModelUsage<T>(
  history: TurnToolHistory,
  work: () => Promise<T>,
): Promise<T> {
  history.tokenUsage.modelUsage ??= [];
  history.checkpointUsage();
  const owner = { history, closed: false };
  return scope.run({ owner }, async () => {
    try {
      return await work();
    } finally {
      owner.closed = true;
    }
  });
}

export function withModelTask<T>(
  task: string,
  work: () => Promise<T>,
): Promise<T> {
  const current = scope.getStore();
  return current ? scope.run({ ...current, task }, work) : work();
}

export async function observeModelUsage(
  args: NormalizedCallArgs,
  estimatePrompt: () => number,
  work: () => Promise<ChatCompletionResponse>,
): Promise<ChatCompletionResponse> {
  const current = scope.getStore();
  if (!current || current.owner.closed) return work();
  const estimatedPromptTokens = estimatePrompt();
  const { history } = current.owner;
  const stats = history.tokenUsage;
  const startedAt = performance.now();
  const call: ModelCallUsage = {
    ...(args.provider ? { provider: args.provider } : {}),
    model: args.model,
    ...(current.task ? { task: current.task } : {}),
    status: 'running',
    durationMs: 0,
    usage: { ...createTokenUsageStats(), modelCalls: 1, estimatedPromptTokens },
  };
  stats.modelUsage ??= [];
  stats.modelUsage.push(call);
  stats.modelCalls++;
  stats.estimatedPromptTokens += estimatedPromptTokens;
  history.checkpointUsage();
  let response: Pick<ChatCompletionResponse, 'usage'> | undefined;
  try {
    const result = await work();
    response = result;
    if (!current.owner.closed) {
      const finish = result.choices[0]?.finish_reason;
      call.status =
        finish && !isCompleteToolCallFinish(finish) ? 'error' : 'success';
      call.usage.estimatedCompletionTokens = estimateResponseTokens(result);
      stats.estimatedCompletionTokens += call.usage.estimatedCompletionTokens;
    }
    return result;
  } catch (error) {
    if (error instanceof IncompleteModelResponseError) response = error;
    if (!current.owner.closed) call.status = 'error';
    throw error;
  } finally {
    if (!current.owner.closed) {
      if (response) {
        accumulateApiUsage(stats, response);
        accumulateApiUsage(call.usage, response);
        const cost = readReportedUsageCost(response.usage, args.provider);
        if (cost !== null) call.costUsd = cost;
      }
      call.durationMs = Math.round(performance.now() - startedAt);
      history.checkpointUsage();
    }
  }
}
