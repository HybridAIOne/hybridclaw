import { runAgent } from '../agent/agent.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { recordUsageEvent } from '../memory/db.js';
import { resolveModelProvider } from '../providers/factory.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage } from '../types.js';

export async function runIsolatedScheduledTask(params: {
  taskId: number;
  prompt: string;
  channelId: string;
  chatbotId: string;
  model: string;
  agentId: string;
  sessionKey?: string;
  onResult: (result: {
    text: string;
    artifacts?: Array<{ path: string; filename: string; mimeType: string }>;
  }) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const {
    taskId,
    prompt,
    channelId,
    chatbotId,
    model,
    agentId,
    sessionKey,
    onResult,
    onError,
  } = params;
  const cronSessionId =
    sessionKey && sessionKey.trim() ? sessionKey.trim() : `cron:${taskId}`;
  const runId = makeAuditRunId('cron');
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  const startedAt = Date.now();
  const provider = resolveModelProvider(model);
  const workspacePath = agentWorkspaceDir(agentId);

  recordAuditEvent({
    sessionId: cronSessionId,
    runId,
    event: {
      type: 'session.start',
      userId: 'scheduler',
      channel: channelId,
      cwd: workspacePath,
      model,
      source: 'scheduler',
      taskId,
    },
  });
  recordAuditEvent({
    sessionId: cronSessionId,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: prompt,
      source: 'scheduler',
      taskId,
    },
  });

  try {
    const output = await runAgent(
      cronSessionId,
      messages,
      chatbotId,
      false,
      model,
      agentId,
      channelId,
      undefined,
      undefined,
      ['cron'],
    );
    emitToolExecutionAuditEvents({
      sessionId: cronSessionId,
      runId,
      toolExecutions: output.toolExecutions || [],
    });
    const tokenUsage = output.tokenUsage;
    const estimatedPromptTokens =
      tokenUsage?.estimatedPromptTokens ||
      estimateTokenCountFromMessages(messages);
    const estimatedCompletionTokens =
      tokenUsage?.estimatedCompletionTokens ||
      estimateTokenCountFromText(output.result || '');
    const estimatedTotalTokens =
      tokenUsage?.estimatedTotalTokens ||
      estimatedPromptTokens + estimatedCompletionTokens;
    const apiUsageAvailable = tokenUsage?.apiUsageAvailable === true;
    const apiPromptTokens = tokenUsage?.apiPromptTokens || 0;
    const apiCompletionTokens = tokenUsage?.apiCompletionTokens || 0;
    const apiTotalTokens =
      tokenUsage?.apiTotalTokens || apiPromptTokens + apiCompletionTokens;
    const apiCacheUsageAvailable = tokenUsage?.apiCacheUsageAvailable === true;
    const apiCacheReadTokens = tokenUsage?.apiCacheReadTokens || 0;
    const apiCacheWriteTokens = tokenUsage?.apiCacheWriteTokens || 0;
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'model.usage',
        provider,
        model,
        durationMs: Date.now() - startedAt,
        toolCallCount: (output.toolExecutions || []).length,
        modelCalls: tokenUsage ? Math.max(1, tokenUsage.modelCalls) : 0,
        promptTokens: apiUsageAvailable
          ? apiPromptTokens
          : estimatedPromptTokens,
        completionTokens: apiUsageAvailable
          ? apiCompletionTokens
          : estimatedCompletionTokens,
        totalTokens: apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens,
        estimatedPromptTokens,
        estimatedCompletionTokens,
        estimatedTotalTokens,
        apiUsageAvailable,
        apiPromptTokens,
        apiCompletionTokens,
        apiTotalTokens,
        ...(apiCacheUsageAvailable
          ? {
              apiCacheUsageAvailable,
              apiCacheReadTokens,
              apiCacheWriteTokens,
              cacheReadTokens: apiCacheReadTokens,
              cacheReadInputTokens: apiCacheReadTokens,
              cacheWriteTokens: apiCacheWriteTokens,
              cacheWriteInputTokens: apiCacheWriteTokens,
            }
          : {}),
      },
    });
    recordUsageEvent({
      sessionId: cronSessionId,
      agentId,
      model,
      inputTokens: apiUsageAvailable ? apiPromptTokens : estimatedPromptTokens,
      outputTokens: apiUsageAvailable
        ? apiCompletionTokens
        : estimatedCompletionTokens,
      totalTokens: apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens,
      toolCalls: (output.toolExecutions || []).length,
    });

    if (output.status === 'success' && output.result) {
      await onResult({
        text: output.result,
        artifacts: output.artifacts,
      });
      recordAuditEvent({
        sessionId: cronSessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex: 1,
          finishReason: 'completed',
        },
      });
      recordAuditEvent({
        sessionId: cronSessionId,
        runId,
        event: {
          type: 'session.end',
          reason: 'normal',
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: (output.toolExecutions || []).length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      return;
    }
    const message = output.error || 'Scheduled task returned no result.';
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'scheduler',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: (output.toolExecutions || []).length,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    onError(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'scheduler',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    onError(error);
  }
}
