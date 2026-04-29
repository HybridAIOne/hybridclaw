import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { getChannel } from '../channels/channel-registry.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { memoryService } from '../memory/memory-service.js';
import { resolveModelProvider } from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import {
  buildSessionKey,
  isLegacySessionKey,
  migrateLegacySessionKey,
} from '../session/session-key.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';
import {
  buildModelUsageAuditStats,
  recordModelUsageAuditEvent,
} from './model-usage.js';

export async function runIsolatedScheduledTask(params: {
  taskId: number;
  prompt: string;
  channelId: string;
  chatbotId: string;
  model: string;
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  mainSessionKey?: string;
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
    mainSessionKey,
    onResult,
    onError,
  } = params;
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
      chatType: 'cron',
      userId: 'scheduler',
      userName: 'scheduler',
      guildId: null,
    },
    agentId,
    sessionId: activeSessionId,
    sessionKey: cronSessionId,
    mainSessionKey: mainSessionKey?.trim() || cronSessionId,
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
    const usage = buildModelUsageAuditStats({
      messages,
      resultText: output.result,
      toolCallCount: (output.toolExecutions || []).length,
      tokenUsage: output.tokenUsage,
    });
    recordModelUsageAuditEvent({
      sessionId: activeSessionId,
      runId,
      provider,
      model,
      startedAt,
      usage,
    });
    enqueueTokenUsage({
      sessionId: activeSessionId,
      agentId,
      model,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      toolCalls: usage.toolCallCount,
      auditRunId: runId,
    });

    if (output.status === 'success' && output.result) {
      memoryService.storeTurn({
        sessionId: activeSessionId,
        user: {
          userId: 'scheduler',
          username: 'scheduler',
          content: prompt,
        },
        assistant: {
          userId: 'assistant',
          username: null,
          agentId,
          content: output.result,
        },
      });
      appendSessionTranscript(agentId, {
        sessionId: activeSessionId,
        channelId,
        role: 'user',
        userId: 'scheduler',
        username: 'scheduler',
        content: prompt,
      });
      appendSessionTranscript(agentId, {
        sessionId: activeSessionId,
        channelId,
        role: 'assistant',
        userId: 'assistant',
        username: null,
        content: output.result,
      });
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
