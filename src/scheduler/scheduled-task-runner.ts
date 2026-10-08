import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import { isSilentReply } from '../agent/silent-reply.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { getChannel } from '../channels/channel-registry.js';
import {
  beginDeviceDataTurn,
  blockDeviceDataToolUnlessShared,
} from '../gateway/device-data.js';
import { replyWithEmailDraft, turnEmailDraft } from '../gateway/email-draft.js';
import type { ProactiveMessagePayload } from '../gateway/fullauto-runtime.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { getSessionById, setMessageEmailDraft } from '../memory/db.js';
import { getJob } from '../memory/jobs.js';
import { memoryService } from '../memory/memory-service.js';
import { resolveModelProvider } from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import { scheduledRunSessionKey } from '../session/session-key.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import { buildEligibleSkillCatalog } from '../skills/skill-catalog.js';
import { trackedTaskPrompt } from '../tracking/track-store.js';
import { buildMediaGenerationUsageEvents } from '../usage/media-generation-usage.js';
import { resolveUsageCostUsdAfterMetadataRefresh } from '../usage/model-cost.js';
import {
  enqueueTokenUsage,
  readCacheTokenUsage,
} from '../usage/token-usage-buffer.js';
import { startWork, updateWork } from '../work/work-store.js';
import { beginWork, workPrompt } from '../work/work-tool.js';
import { isConnectorEventCurrent } from './connector-events.js';
import {
  buildModelUsageAuditStats,
  recordModelUsageAuditEvent,
} from './model-usage.js';
import {
  cronPromptHead,
  dbTaskLabel,
  type SchedulerDispatchRequest,
} from './scheduler.js';

// One day (engineering choice, 2026-10-03): background work must not use an old phone snapshot.
const MAX_DEVICE_AGE_MS = 24 * 60 * 60 * 1000;

export async function runIsolatedScheduledTask(params: {
  taskId: number;
  originSessionId?: string;
  taskOwner?: SchedulerDispatchRequest['taskOwner'];
  prompt: string;
  channelId: string;
  chatbotId: string;
  model: string;
  reasoningEffort?: import('../../container/shared/reasoning-effort.js').ReasoningEffort;
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  mainSessionKey?: string;
  onResult: (result: ProactiveMessagePayload) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const {
    taskId,
    taskOwner,
    prompt: storedPrompt,
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
  const prompt = workPrompt(trackedTaskPrompt(taskId, storedPrompt));
  const cronSessionId = scheduledRunSessionKey(agentId, taskId, sessionKey);
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
  const task = getJob(taskId, { kind: 'scheduled_task' });
  if (task?.event_parent_id && !isConnectorEventCurrent(task)) return;
  const taskSession = task ? getSessionById(task.session_id) : null;
  const owner =
    task?.enabled &&
    task.channel_id === channelId &&
    taskOwner?.userId === task.owner_user_id &&
    taskOwner?.sessionId === task.session_id &&
    (task.prompt === storedPrompt ||
      storedPrompt.startsWith(
        cronPromptHead(dbTaskLabel(task.id), task.prompt),
      )) &&
    taskSession?.agent_id === agentId
      ? task.owner_user_id
      : undefined;
  startWork({
    id: runId,
    agentId,
    owner: owner ?? null,
    sessionId: params.originSessionId ?? sessionId ?? activeSessionId,
    runSessionId: activeSessionId,
    taskId: taskId > 0 ? taskId : null,
  });
  const blockedTools = blockDeviceDataToolUnlessShared(['cron'], owner);
  const { messages, skills } = buildConversationContext({
    agentId,
    preferenceUserId: owner ?? null,
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
    blockedTools,
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

  const endDeviceData = beginDeviceDataTurn(
    activeSessionId,
    owner,
    MAX_DEVICE_AGE_MS,
  );
  const endWork = beginWork(activeSessionId, runId);
  try {
    const output = await runAgent({
      sessionId: activeSessionId,
      runId,
      messages,
      chatbotId,
      enableRag: false,
      reasoningEffort: params.reasoningEffort,
      model,
      agentId,
      channelId,
      blockedTools,
      skillCatalog: buildEligibleSkillCatalog(skills),
      background: true,
    });
    emitToolExecutionAuditEvents({
      sessionId: activeSessionId,
      runId,
      toolExecutions: output.toolExecutions || [],
    });
    updateWork(runId, (work) => {
      work.actions = (output.toolExecutions ?? []).flatMap((tool, index) =>
        tool.blocked
          ? []
          : [
              {
                toolCallId: `${runId}:tool:${index + 1}`,
                tool: tool.name,
                ok: tool.isError !== true,
              },
            ],
      );
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
      ...readCacheTokenUsage(usage),
      toolCalls: usage.toolCallCount,
      costUsd: await resolveUsageCostUsdAfterMetadataRefresh({
        model,
        tokenUsage: output.tokenUsage,
        usage,
      }),
      auditRunId: runId,
    });
    for (const event of buildMediaGenerationUsageEvents({
      sessionId: activeSessionId,
      agentId,
      auditRunId: runId,
      toolExecutions: output.toolExecutions || [],
    })) {
      enqueueTokenUsage(event);
    }

    const shown =
      output.status === 'success' && !isSilentReply(output.result ?? '')
        ? replyWithEmailDraft(
            output.result ?? '',
            turnEmailDraft(output.toolExecutions),
            { proactive: true },
          )
        : { content: output.result ?? '' };
    if (output.status === 'success' && shown.content) {
      updateWork(runId, (work) => {
        work.completedAt = new Date().toISOString();
        work.artifacts = (output.artifacts ?? []).map((item) => item.path);
      });
      const storedTurn = memoryService.storeTurn({
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
          content: shown.content,
          source:
            taskId > 0
              ? `schedule:${task?.event_parent_id ?? taskId}`
              : undefined,
          artifacts: output.artifacts,
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
        content: shown.content,
      });
      if (shown.emailDraft) {
        setMessageEmailDraft(storedTurn.assistantMessageId, shown.emailDraft);
      }
      if (!isSilentReply(shown.content)) {
        await onResult({
          text: shown.content,
          workId: runId,
          storedMessage: {
            sessionId: activeSessionId,
            id: storedTurn.assistantMessageId,
          },
          artifacts: output.artifacts,
        });
      }
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
    updateWork(runId, (work) => {
      work.failedAt = new Date().toISOString();
    });
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
    updateWork(runId, (work) => {
      if (!work.completedAt) work.failedAt = new Date().toISOString();
    });
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
  } finally {
    endDeviceData();
    endWork();
  }
}
