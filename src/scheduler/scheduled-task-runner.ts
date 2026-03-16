import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { SYSTEM_CAPABILITIES } from '../channels/channel.js';
import {
  getChannel,
  listChannels,
  registerChannel,
} from '../channels/channel-registry.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { recordUsageEvent } from '../memory/db.js';
import { resolveModelProvider } from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import {
  buildSessionKey,
  isLegacySessionKey,
  migrateLegacySessionKey,
} from '../session/session-key.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';

export async function runIsolatedScheduledTask(params: {
  taskId: number;
  prompt: string;
  channelId: string;
  chatbotId: string;
  model: string;
  agentId: string;
  sessionId?: string;
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
    sessionId,
    sessionKey,
    onResult,
    onError,
  } = params;
  registerChannel({
    kind: 'scheduler',
    id: 'scheduler',
    capabilities: SYSTEM_CAPABILITIES,
  });
  const rawSessionKey = sessionKey?.trim()
    ? sessionKey.trim()
    : buildSessionKey(agentId, 'scheduler', 'cron', String(taskId));
  const cronSessionId = isLegacySessionKey(rawSessionKey)
    ? migrateLegacySessionKey(rawSessionKey, {
        agent_id: agentId,
      })
    : rawSessionKey;
  const activeSessionId = String(sessionId || '').trim() || cronSessionId;
  const runId = makeAuditRunId('cron');
  const startedAt = Date.now();
  const provider = resolveModelProvider(model);
  const workspacePath = agentWorkspaceDir(agentId);
  const sessionContext = buildSessionContext({
    source: {
      channelKind: 'scheduler',
      chatId: channelId,
      chatType: 'system',
      userId: 'scheduler',
      userName: 'scheduler',
      guildId: null,
    },
    agentId,
    sessionId: activeSessionId,
    sessionKey: cronSessionId,
    connectedChannels: listChannels().map((channel) => channel.kind),
  });
  const { messages } = buildConversationContext({
    agentId,
    history: [],
    currentUserContent: prompt,
    runtimeInfo: {
      channel: getChannel('scheduler'),
      chatbotId,
      model,
      defaultModel: model,
      channelType: 'scheduler',
      channelId,
      guildId: null,
      sessionContext,
      workspacePath,
    },
    blockedTools: ['cron'],
  });
  messages.push({ role: 'user', content: prompt });

  recordAuditEvent({
    sessionId: activeSessionId,
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
    sessionId: activeSessionId,
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
    const output = await runAgent({
      sessionId: activeSessionId,
      messages,
      chatbotId,
      enableRag: false,
      model,
      agentId,
      channelId,
      blockedTools: ['cron'],
    });
    emitToolExecutionAuditEvents({
      sessionId: activeSessionId,
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
      sessionId: activeSessionId,
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
      sessionId: activeSessionId,
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
        sessionId: activeSessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex: 1,
          finishReason: 'completed',
        },
      });
      recordAuditEvent({
        sessionId: activeSessionId,
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
      sessionId: activeSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'scheduler',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: activeSessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: activeSessionId,
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
      sessionId: activeSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'scheduler',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: activeSessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: activeSessionId,
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
