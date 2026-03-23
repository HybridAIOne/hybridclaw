import path from 'node:path';
import { assembleConversationPromptContext } from '../../agent/conversation.js';
import { processSideEffects } from '../../agent/side-effects.js';
import { isSilentReply } from '../../agent/silent-reply.js';
import { resolveAgentForRequest } from '../../agents/agent-registry.js';
import {
  emitToolExecutionAuditEvents,
  recordAuditEvent,
} from '../../audit/audit-events.js';
import {
  getChannel,
  getChannelByContextId,
} from '../../channels/channel-registry.js';
import {
  HYBRIDAI_MODEL,
  PROACTIVE_DELEGATION_MAX_DEPTH,
  PROACTIVE_DELEGATION_MAX_PER_TURN,
} from '../../config/config.js';
import type { RuntimeConfig } from '../../config/runtime-config.js';
import { agentWorkspaceDir } from '../../infra/ipc.js';
import { logger } from '../../logger.js';
import { prependAudioTranscriptionsToUserContent } from '../../media/audio-transcription.js';
import { extractMemoryCitations } from '../../memory/citation-extractor.js';
import {
  createFreshSessionInstance,
  recordUsageEvent,
} from '../../memory/db.js';
import { memoryService } from '../../memory/memory-service.js';
import { DEFAULT_MIDDLEWARE_TIMEOUTS_MS } from '../../middleware/chain.js';
import { resolveModelProvider } from '../../providers/factory.js';
import { buildSessionContext } from '../../session/session-context.js';
import {
  resolveResetPolicy,
  resolveSessionResetChannelKind,
} from '../../session/session-reset.js';
import { estimateTokenCountFromMessages } from '../../session/token-efficiency.js';
import { resolveObservedSkillName } from '../../skills/skills.js';
import {
  deriveSkillExecutionOutcome,
  recordSkillExecution,
} from '../../skills/skills-observation.js';
import type {
  CanonicalSessionContext,
  ChatMessage,
  DelegationSideEffect,
} from '../../types.js';
import { ensureBootstrapFiles } from '../../workspace.js';
import {
  buildFullAutoOperatingContract,
  clearScheduledFullAutoContinuation,
  disableFullAutoSession,
  isFullAutoEnabled,
  maybeScheduleFullAutoAfterSuccess,
  noteFullAutoSupervisedIntervention,
  preemptRunningFullAutoTurn,
  syncFullAutoRuntimeContext,
} from '../fullauto.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from '../show-mode.js';
import {
  buildGatewaySuccessResultState,
  buildMediaPromptContext,
  buildTokenUsageAuditPayload,
  countConsecutiveMatchingTurns,
  extractUsageCostUsd,
  formatCanonicalContextPrompt,
  formatPluginPromptContext,
  isClarificationRequest,
  normalizeMediaContextItems,
  resolveChannelType,
  resolveMediaToolPolicy,
} from './helpers.js';
import type {
  GatewayAnalyzedContext,
  GatewayChatChainInput,
  GatewayCompletedContext,
  GatewayMediaPreparedContext,
  GatewayMemoryPreparedContext,
  GatewayMiddlewareDependencies,
  GatewayModelInvocationContext,
  GatewayModelOutputContext,
  GatewayPromptPreparedContext,
  GatewayRawModelOutputContext,
  GatewaySessionPreparedContext,
} from './types.js';

const GATEWAY_TURN_LOOP_WARNING_THRESHOLD = 3;
const GATEWAY_TURN_LOOP_FORCE_STOP_THRESHOLD = 5;
const GATEWAY_TURN_LOOP_WARNING_PREFIX = '[Loop warning]';
const GATEWAY_TURN_LOOP_GUARD_PREFIX = '[Loop guard]';
const GATEWAY_SESSION_MIDDLEWARE_TIMEOUT_MS = 30_000;
const GATEWAY_MEDIA_MIDDLEWARE_TIMEOUT_MS = 60_000;
const GATEWAY_MEMORY_MIDDLEWARE_TIMEOUT_MS = 15_000;
const GATEWAY_PROMPT_ASSEMBLY_TIMEOUT_MS = 15_000;
const GATEWAY_PLUGIN_HOOK_TIMEOUT_MS = 1_000;
const GATEWAY_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS = 0;

type GatewayChatPhase =
  | 'beforeAgent'
  | 'beforeModel'
  | 'afterModel'
  | 'afterAgent';

function resolveSessionResetPolicy(config: RuntimeConfig, channelId: string) {
  return resolveResetPolicy({
    channelKind: resolveSessionResetChannelKind(channelId),
    config,
  });
}

function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (!(timeoutMs > 0)) return operation;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

async function runBestEffortPluginPreparation<T>(params: {
  sessionId: string;
  channelId: string;
  agentId: string;
  label: string;
  timeoutMs: number;
  fallback: T;
  operation: (abortSignal?: AbortSignal) => Promise<T>;
  warningMessage: string;
  abortSignal?: AbortSignal;
  abortOnTimeout?: boolean;
}): Promise<T> {
  const timeoutController = params.abortOnTimeout
    ? new AbortController()
    : undefined;
  const operationAbortSignal =
    params.abortSignal && timeoutController
      ? AbortSignal.any([params.abortSignal, timeoutController.signal])
      : params.abortSignal || timeoutController?.signal;
  let timedOut = false;
  try {
    return await withOperationTimeout(
      params.operation(operationAbortSignal),
      params.timeoutMs,
      params.label,
      () => {
        timedOut = true;
        timeoutController?.abort();
      },
    );
  } catch (error) {
    if (!timedOut && params.abortSignal?.aborted) {
      return params.fallback;
    }
    logger.warn(
      {
        sessionId: params.sessionId,
        channelId: params.channelId,
        agentId: params.agentId,
        timeoutMs: params.timeoutMs,
        error,
      },
      params.warningMessage,
    );
    return params.fallback;
  }
}

function resolveGatewayPhaseTimeoutMs(
  middleware: {
    timeoutsMs?: Partial<Record<GatewayChatPhase, number>>;
  },
  phase: GatewayChatPhase,
): number {
  const override = middleware.timeoutsMs?.[phase];
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override >= 0
  ) {
    return override;
  }
  return DEFAULT_MIDDLEWARE_TIMEOUTS_MS[phase];
}

async function runGatewayPhaseStep<
  TContext extends { config: RuntimeConfig },
  TNextContext,
>(
  middleware: {
    name: string;
    isEnabled(config: RuntimeConfig): boolean;
    timeoutsMs?: Partial<Record<GatewayChatPhase, number>>;
  },
  phase: GatewayChatPhase,
  ctx: TContext,
  handler: (ctx: TContext) => Promise<TNextContext>,
): Promise<TNextContext> {
  if (!middleware.isEnabled(ctx.config)) {
    return ctx as unknown as TNextContext;
  }
  return await withOperationTimeout(
    handler(ctx),
    resolveGatewayPhaseTimeoutMs(middleware, phase),
    `Middleware "${middleware.name}" ${phase}`,
  );
}

class SessionMiddleware {
  readonly name = 'session';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_SESSION_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(
    ctx: GatewayChatChainInput,
  ): Promise<GatewaySessionPreparedContext> {
    const req = ctx.request;
    const sessionResetPolicy = resolveSessionResetPolicy(
      ctx.config,
      req.channelId,
    );
    let session = await this.deps.prepareGatewaySessionRecord({
      request: req,
      pluginManager: ctx.pluginManager,
    });

    if (ctx.source !== 'fullauto') {
      preemptRunningFullAutoTurn(req.sessionId, ctx.source);
      clearScheduledFullAutoContinuation(req.sessionId);
      if (isFullAutoEnabled(session)) {
        noteFullAutoSupervisedIntervention({
          session,
          content: req.content,
          source: ctx.source,
        });
      }
    }

    const resolvedRequest = resolveAgentForRequest({
      agentId: req.agentId,
      session,
      model: req.model,
      chatbotId: req.chatbotId,
    });
    const { agentId, model, chatbotId } = resolvedRequest;
    const channelType =
      resolveChannelType(req) || resolveSessionResetChannelKind(req.channelId);
    const channel =
      (channelType ? getChannel(channelType) : undefined) ||
      getChannelByContextId(req.channelId) ||
      undefined;

    if (session.agent_id !== agentId) {
      const reboundExpiryEvaluation = await this.deps.prepareSessionAutoReset({
        sessionId: req.sessionId,
        channelId: req.channelId,
        agentId,
        chatbotId,
        model,
        enableRag: req.enableRag ?? session.enable_rag === 1,
        policy: sessionResetPolicy,
      });
      const reboundSession = memoryService.resetSessionIfExpired(
        req.sessionId,
        {
          policy: sessionResetPolicy,
          expiryEvaluation: reboundExpiryEvaluation,
        },
      );
      if (reboundSession && ctx.pluginManager) {
        const pluginManager = ctx.pluginManager;
        const previousSessionId = req.sessionId;
        req.sessionId = reboundSession.id;
        await runBestEffortPluginPreparation({
          sessionId: req.sessionId,
          channelId: req.channelId,
          agentId,
          label: 'Plugin session reset hook',
          timeoutMs: GATEWAY_PLUGIN_HOOK_TIMEOUT_MS,
          fallback: undefined,
          operation: () =>
            pluginManager.handleSessionReset({
              previousSessionId,
              sessionId: req.sessionId,
              userId: req.userId,
              agentId,
              channelId: req.channelId,
              reason: 'auto-reset',
            }),
          warningMessage:
            'Plugin session-reset hook failed during gateway session preparation',
        });
      }
      session = memoryService.getOrCreateSession(
        req.sessionId,
        req.guildId,
        req.channelId,
        agentId,
        { forceNewCurrent: this.deps.shouldForceNewTuiSession(req) },
      );
      if (session.id !== req.sessionId) {
        req.sessionId = session.id;
      }
    }

    const workspacePath = path.resolve(agentWorkspaceDir(agentId));
    const workspaceBootstrap = ensureBootstrapFiles(agentId);
    if (
      workspaceBootstrap.workspaceInitialized &&
      (session.message_count > 0 || Boolean(session.session_summary))
    ) {
      const rotated = createFreshSessionInstance(req.sessionId);
      req.sessionId = rotated.session.id;
      session = rotated.session;
      if (ctx.pluginManager) {
        const pluginManager = ctx.pluginManager;
        await runBestEffortPluginPreparation({
          sessionId: rotated.session.id,
          channelId: req.channelId,
          agentId,
          label: 'Plugin workspace reset hook',
          timeoutMs: GATEWAY_PLUGIN_HOOK_TIMEOUT_MS,
          fallback: undefined,
          operation: () =>
            pluginManager.handleSessionReset({
              previousSessionId: rotated.previousSession.id,
              sessionId: rotated.session.id,
              userId: req.userId,
              agentId,
              channelId: req.channelId,
              reason: 'workspace-reset',
            }),
          warningMessage:
            'Plugin workspace-reset hook failed during gateway session preparation',
        });
      }
      logger.info(
        {
          sessionId: req.sessionId,
          previousSessionId: rotated.previousSession.id,
          sessionKey: session.session_key,
          agentId,
          workspacePath: workspaceBootstrap.workspacePath,
          clearedMessages: rotated.deletedMessages,
        },
        'Cleared session history after workspace reset',
      );
    }

    const sessionContext = buildSessionContext({
      source: {
        channelKind: channelType || channel?.kind,
        chatId: req.channelId,
        chatType:
          channelType === 'heartbeat' || channelType === 'scheduler'
            ? 'system'
            : req.guildId
              ? 'channel'
              : 'dm',
        userId: req.userId,
        userName: req.username ?? undefined,
        guildId: req.guildId,
      },
      agentId,
      sessionId: session.id,
      sessionKey: session.session_key,
      mainSessionKey: session.main_session_key,
    });
    const showMode = normalizeSessionShowMode(session.show_mode);
    const shouldEmitTools = sessionShowModeShowsTools(showMode);
    const enableRag = req.enableRag ?? session.enable_rag === 1;
    const provider = resolveModelProvider(model);
    const canonicalContextScope =
      this.deps.resolveCanonicalContextScope(session);

    if (isFullAutoEnabled(session)) {
      syncFullAutoRuntimeContext(req.sessionId, {
        guildId: req.guildId,
        userId: req.userId,
        username: req.username ?? null,
        chatbotId,
        model,
        enableRag,
        onProactiveMessage: req.onProactiveMessage ?? null,
      });
    }

    const turnIndex = session.message_count + 1;
    if (turnIndex === 1 && ctx.pluginManager) {
      const pluginManager = ctx.pluginManager;
      await runBestEffortPluginPreparation({
        sessionId: req.sessionId,
        channelId: req.channelId,
        agentId,
        label: 'Plugin session-start hook',
        timeoutMs: GATEWAY_PLUGIN_HOOK_TIMEOUT_MS,
        fallback: undefined,
        operation: () =>
          pluginManager.notifySessionStart({
            sessionId: req.sessionId,
            userId: req.userId,
            agentId,
            channelId: req.channelId,
          }),
        warningMessage:
          'Plugin session-start hook failed during gateway session preparation',
      });
    }

    return {
      ...ctx,
      session,
      agentId,
      model,
      chatbotId: chatbotId || '',
      enableRag,
      provider,
      channelType,
      channel,
      sessionContext,
      shouldEmitTools,
      workspacePath,
      canonicalContextScope,
      turnIndex,
    };
  }
}

class MediaProcessingMiddleware {
  readonly name = 'media-processing';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_MEDIA_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(
    ctx: GatewaySessionPreparedContext,
  ): Promise<GatewayMediaPreparedContext> {
    const media = normalizeMediaContextItems(ctx.request.media);
    const audioPrelude = await prependAudioTranscriptionsToUserContent({
      content: ctx.request.content,
      media,
      workspaceRoot: ctx.workspacePath,
      abortSignal: ctx.abortSignal,
    });
    const userTurnContent = audioPrelude.content;

    return {
      ...ctx,
      media,
      mediaPolicy: resolveMediaToolPolicy(userTurnContent, media),
      userTurnContent,
      audioTranscriptCount: audioPrelude.transcripts.length,
    };
  }
}

class MemoryMiddleware {
  readonly name = 'memory';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_MEMORY_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(
    ctx: GatewayMediaPreparedContext,
  ): Promise<GatewayMemoryPreparedContext> {
    const history = memoryService
      .getConversationHistory(
        ctx.request.sessionId,
        this.deps.maxHistoryMessages * 2,
      )
      .filter((message) => !isSilentReply(message.content))
      .slice(0, this.deps.maxHistoryMessages);

    let pluginsUsed: string[] = [];
    let canonicalContext: CanonicalSessionContext = {
      summary: null,
      recent_messages: [],
    };

    if (ctx.canonicalContextScope) {
      try {
        canonicalContext = memoryService.getCanonicalContext({
          agentId: ctx.agentId,
          userId: ctx.canonicalContextScope,
          windowSize: 12,
          excludeSessionId: ctx.request.sessionId,
        });
        canonicalContext = {
          ...canonicalContext,
          recent_messages: canonicalContext.recent_messages.filter(
            (message) => !isSilentReply(message.content),
          ),
        };
      } catch (err) {
        logger.debug(
          {
            sessionId: ctx.request.sessionId,
            canonicalContextScope: ctx.canonicalContextScope,
            err,
          },
          'Failed to load canonical session context',
        );
      }
    }

    const canonicalPromptSummary = formatCanonicalContextPrompt({
      summary: canonicalContext.summary,
      recentMessages: canonicalContext.recent_messages,
    });
    const pluginRecentMessages = [...history].reverse();
    pluginRecentMessages.push({
      id: 0,
      session_id: ctx.request.sessionId,
      user_id: ctx.request.userId,
      username: ctx.request.username || null,
      role: 'user',
      content: ctx.userTurnContent,
      created_at: new Date(ctx.startedAt).toISOString(),
    });
    const pluginPromptDetails = ctx.pluginManager
      ? await runBestEffortPluginPreparation({
          sessionId: ctx.request.sessionId,
          channelId: ctx.request.channelId,
          agentId: ctx.agentId,
          label: 'Plugin prompt context collection',
          timeoutMs: GATEWAY_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS,
          abortSignal: ctx.abortSignal,
          fallback: { sections: [], pluginIds: [] },
          operation: (abortSignal) => {
            const pluginManager = ctx.pluginManager;
            if (!pluginManager) {
              return Promise.resolve({ sections: [], pluginIds: [] });
            }
            return pluginManager.collectPromptContextDetails({
              sessionId: ctx.request.sessionId,
              userId: ctx.request.userId,
              agentId: ctx.agentId,
              channelId: ctx.request.channelId,
              recentMessages: pluginRecentMessages,
              abortSignal,
            });
          },
          warningMessage:
            'Plugin prompt context collection failed during gateway session preparation',
        })
      : { sections: [], pluginIds: [] };
    pluginsUsed = pluginPromptDetails.pluginIds;
    const pluginPromptSummary = formatPluginPromptContext(
      pluginPromptDetails.sections,
    );
    const memoryContext = memoryService.buildPromptMemoryContext({
      session: ctx.session,
      query: ctx.userTurnContent,
    });
    const mergedSessionSummary =
      [canonicalPromptSummary, memoryContext.promptSummary]
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .join('\n\n')
        .trim() || null;

    return {
      ...ctx,
      history,
      mergedSessionSummary,
      pluginPromptSummary,
      canonicalPromptSummary,
      canonicalRecentMessagesIncluded: canonicalContext.recent_messages.length,
      pluginsUsed,
      memoryContext,
    };
  }
}

class PromptAssemblyMiddleware {
  readonly name = 'prompt-assembly';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_PROMPT_ASSEMBLY_TIMEOUT_MS,
  } as const;

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(
    ctx: GatewayMemoryPreparedContext,
  ): Promise<GatewayPromptPreparedContext> {
    const fullAutoOperatingContract = isFullAutoEnabled(ctx.session)
      ? buildFullAutoOperatingContract(
          ctx.session,
          ctx.source === 'fullauto' ? 'background' : 'supervised',
        )
      : undefined;
    const promptContext = assembleConversationPromptContext({
      agentId: ctx.agentId,
      sessionSummary: ctx.mergedSessionSummary,
      retrievedContext: ctx.pluginPromptSummary,
      history: ctx.history,
      currentUserContent: ctx.userTurnContent,
      promptMode: 'full',
      extraSafetyText: fullAutoOperatingContract,
      runtimeInfo: {
        chatbotId: ctx.chatbotId || undefined,
        model: ctx.model,
        defaultModel: HYBRIDAI_MODEL,
        channel: ctx.channel,
        channelType: ctx.channelType,
        channelId: ctx.request.channelId,
        guildId: ctx.request.guildId,
        sessionContext: ctx.sessionContext,
        workspacePath: ctx.workspacePath,
      },
      blockedTools: ctx.mediaPolicy.blockedTools,
    });
    const mediaContextBlock = buildMediaPromptContext(ctx.media);
    const expandedUserContent = promptContext.currentUserContent;
    const agentUserContent = mediaContextBlock
      ? `${expandedUserContent}\n\n${mediaContextBlock}`
      : expandedUserContent;
    const promptMessages: ChatMessage[] = [
      ...promptContext.messages,
      {
        role: 'user',
        content: agentUserContent,
      },
    ];

    return {
      ...ctx,
      messages: promptMessages,
      explicitSkillName: promptContext.explicitSkillName ?? null,
      requestMessages: ctx.requestLoggingEnabled
        ? promptMessages.slice()
        : null,
      historyStats: promptContext.historyStats,
      historyLength: ctx.history.length,
      skillCount: promptContext.skills.length,
      skills: promptContext.skills,
    };
  }
}

class AuditMiddleware {
  readonly name = 'audit';

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(
    ctx: GatewayPromptPreparedContext,
  ): Promise<GatewayPromptPreparedContext> {
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.runId,
      event: {
        type: 'session.start',
        userId: ctx.request.userId,
        channel: ctx.request.channelId,
        cwd: ctx.workspacePath,
        model: ctx.model,
        source: ctx.source,
      },
    });
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.runId,
      event: {
        type: 'turn.start',
        turnIndex: ctx.turnIndex,
        userInput: ctx.userTurnContent,
        ...(ctx.userTurnContent !== ctx.request.content
          ? { rawUserInput: ctx.request.content }
          : {}),
        username: ctx.request.username,
        mediaCount: ctx.media.length,
        source: ctx.source,
      },
    });

    const historyStart =
      ctx.messages.length > 0 && ctx.messages[0]?.role === 'system' ? 1 : 0;
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.runId,
      event: {
        type: 'context.optimization',
        historyMessagesOriginal: ctx.historyStats.originalCount,
        historyMessagesIncluded: ctx.historyStats.includedCount,
        historyMessagesDropped: ctx.historyStats.droppedCount,
        historyCharsOriginal: ctx.historyStats.originalChars,
        historyCharsPreBudget: ctx.historyStats.preBudgetChars,
        historyCharsIncluded: ctx.historyStats.includedChars,
        historyCharsDropped: ctx.historyStats.droppedChars,
        historyMaxChars: ctx.historyStats.maxTotalChars,
        historyMaxMessageChars: ctx.historyStats.maxMessageChars,
        perMessageTruncatedCount: ctx.historyStats.perMessageTruncatedCount,
        middleCompressionApplied: ctx.historyStats.middleCompressionApplied,
        historyEstimatedTokens: estimateTokenCountFromMessages(
          ctx.messages.slice(historyStart),
        ),
        canonicalSummaryIncluded: Boolean(ctx.canonicalPromptSummary),
        canonicalRecentMessagesIncluded: ctx.canonicalRecentMessagesIncluded,
      },
    });

    return ctx;
  }
}

class ModelLifecycleMiddleware {
  readonly name = 'model-lifecycle';
  readonly timeoutsMs = {
    beforeModel: 0,
  } as const;

  isEnabled(): boolean {
    return true;
  }

  async beforeModel(
    ctx: GatewayModelInvocationContext,
  ): Promise<GatewayModelInvocationContext> {
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.runId,
      event: {
        type: 'agent.start',
        provider: ctx.provider,
        model: ctx.model,
        scheduledTaskCount: ctx.scheduledTaskCount,
        promptMessages: ctx.messages.length,
      },
    });

    if (ctx.pluginManager) {
      await ctx.pluginManager.notifyBeforeAgentStart({
        sessionId: ctx.request.sessionId,
        userId: ctx.request.userId,
        agentId: ctx.agentId,
        channelId: ctx.request.channelId,
        model: ctx.model,
      });
    }

    return ctx;
  }

  async afterModel(
    ctx: GatewayRawModelOutputContext,
  ): Promise<GatewayModelOutputContext> {
    return {
      ...ctx,
      durationMs: Math.max(0, Date.now() - ctx.startedAt),
    };
  }
}

class ToolAnalysisMiddleware {
  readonly name = 'tool-analysis';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayModelOutputContext,
  ): Promise<GatewayAnalyzedContext> {
    const effectiveUserContent =
      typeof ctx.output.effectiveUserPrompt === 'string' &&
      ctx.output.effectiveUserPrompt.trim()
        ? ctx.output.effectiveUserPrompt.trim()
        : ctx.userTurnContent;
    const toolExecutions = ctx.output.toolExecutions || [];
    const observedSkillName = resolveObservedSkillName({
      explicitSkillName: ctx.explicitSkillName,
      toolExecutions,
      skills: ctx.skills,
    });
    emitToolExecutionAuditEvents({
      sessionId: ctx.request.sessionId,
      runId: ctx.runId,
      toolExecutions,
    });
    const usagePayload = buildTokenUsageAuditPayload(
      ctx.messages,
      ctx.output.result,
      ctx.output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.runId,
      event: {
        type: 'model.usage',
        provider: ctx.provider,
        model: ctx.model,
        durationMs: ctx.durationMs,
        toolCallCount: toolExecutions.length,
        ...usagePayload,
      },
    });
    recordUsageEvent({
      sessionId: ctx.request.sessionId,
      agentId: ctx.agentId,
      model: ctx.model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: toolExecutions.length,
      costUsd: extractUsageCostUsd(ctx.output.tokenUsage),
    });
    if (observedSkillName) {
      try {
        recordSkillExecution({
          skillName: observedSkillName,
          sessionId: ctx.request.sessionId,
          runId: ctx.runId,
          toolExecutions,
          outcome: deriveSkillExecutionOutcome({
            outputStatus: ctx.output.status,
            toolExecutions,
          }),
          durationMs: ctx.durationMs,
          errorDetail: ctx.output.error,
        });
      } catch (error) {
        logger.warn(
          {
            sessionId: ctx.request.sessionId,
            skillName: observedSkillName,
            error,
          },
          'Failed to record skill execution observation',
        );
      }
    }

    let nextOutput = ctx.output;
    let resultText: string | undefined;
    if (ctx.output.status !== 'error') {
      resultText = ctx.output.result || 'No response from agent.';
      const memoryCitations = extractMemoryCitations(
        resultText,
        ctx.memoryContext.citationIndex || [],
      );
      if (memoryCitations.length > 0) {
        nextOutput = {
          ...ctx.output,
          memoryCitations,
        };
      }
    }

    return {
      ...ctx,
      output: nextOutput,
      effectiveUserContent,
      toolExecutions,
      observedSkillName,
      usagePayload,
      ...(typeof resultText === 'string' ? { resultText } : {}),
      ...(ctx.output.status === 'error'
        ? { errorMessage: ctx.output.error || 'Unknown agent error.' }
        : {}),
    };
  }
}

class CompletionMiddleware {
  readonly name = 'completion';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayAnalyzedContext,
  ): Promise<GatewayCompletedContext> {
    if (ctx.output.status === 'error') {
      const errorMessage = ctx.errorMessage || 'Unknown agent error.';
      logger.debug(
        {
          sessionId: ctx.request.sessionId,
          guildId: ctx.request.guildId,
          channelId: ctx.request.channelId,
          userId: ctx.request.userId,
          model: ctx.model,
          provider: ctx.provider,
          turnIndex: ctx.turnIndex,
          mediaCount: ctx.media.length,
          audioTranscriptCount: ctx.audioTranscriptCount,
          contentLength: ctx.userTurnContent.length,
          streamingRequested: Boolean(
            ctx.request.onTextDelta ||
              ctx.request.onToolProgress ||
              ctx.request.onApprovalProgress,
          ),
          durationMs: ctx.durationMs,
          toolCallCount: ctx.toolExecutions.length,
          firstTextDeltaMs: ctx.firstTextDeltaMs,
          artifactCount: ctx.output.artifacts?.length || 0,
        },
        'Gateway chat completed with agent error',
      );
      recordAuditEvent({
        sessionId: ctx.request.sessionId,
        runId: ctx.runId,
        event: {
          type: 'error',
          errorType: 'agent',
          message: errorMessage,
          recoverable: true,
          stage: 'processing-agent-output',
        },
      });
      recordAuditEvent({
        sessionId: ctx.request.sessionId,
        runId: ctx.runId,
        event: {
          type: 'turn.end',
          turnIndex: ctx.turnIndex,
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId: ctx.request.sessionId,
        runId: ctx.runId,
        event: {
          type: 'session.end',
          reason: 'error',
          stats: {
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: ctx.toolExecutions.length,
            durationMs: ctx.durationMs,
          },
        },
      });
      return {
        ...ctx,
        finalResult: {
          status: 'error',
          result: null,
          toolsUsed: ctx.output.toolsUsed || [],
          pluginsUsed: ctx.pluginsUsed,
          artifacts: ctx.output.artifacts,
          toolExecutions: ctx.toolExecutions,
          tokenUsage: ctx.output.tokenUsage,
          error: errorMessage,
        },
        clarificationRequested: false,
        turnLoopRepeatCount: null,
        turnLoopAction: null,
      };
    }

    const resultText = ctx.resultText || 'No response from agent.';
    logger.debug(
      {
        sessionId: ctx.request.sessionId,
        guildId: ctx.request.guildId,
        channelId: ctx.request.channelId,
        userId: ctx.request.userId,
        model: ctx.model,
        provider: ctx.provider,
        turnIndex: ctx.turnIndex,
        mediaCount: ctx.media.length,
        audioTranscriptCount: ctx.audioTranscriptCount,
        contentLength: ctx.userTurnContent.length,
        streamingRequested: Boolean(
          ctx.request.onTextDelta ||
            ctx.request.onToolProgress ||
            ctx.request.onApprovalProgress,
        ),
        durationMs: ctx.durationMs,
        toolCallCount: ctx.toolExecutions.length,
        firstTextDeltaMs: ctx.firstTextDeltaMs,
        artifactCount: ctx.output.artifacts?.length || 0,
      },
      'Gateway chat completed successfully',
    );
    return {
      ...ctx,
      ...buildGatewaySuccessResultState({
        request: ctx.request,
        output: ctx.output,
        pluginsUsed: ctx.pluginsUsed,
        toolExecutions: ctx.toolExecutions,
        userContent: ctx.effectiveUserContent,
        resultText,
      }),
      clarificationRequested: false,
      turnLoopRepeatCount: null,
      turnLoopAction: null,
    };
  }
}

class ClarificationMiddleware {
  readonly name = 'clarification';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayCompletedContext,
  ): Promise<GatewayCompletedContext> {
    if (ctx.finalResult.status !== 'success' || !ctx.resultText) {
      return ctx;
    }
    if (!isClarificationRequest(ctx.resultText)) {
      return ctx;
    }
    return {
      ...ctx,
      clarificationRequested: true,
    };
  }
}

class GatewayLoopDetectionMiddleware {
  readonly name = 'gateway-loop-detection';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayCompletedContext,
  ): Promise<GatewayCompletedContext> {
    const resultText = String(ctx.resultText || '').trim();
    if (
      ctx.finalResult.status !== 'success' ||
      !resultText ||
      ctx.clarificationRequested
    ) {
      return ctx;
    }
    if (ctx.source !== 'fullauto' && !isFullAutoEnabled(ctx.session)) {
      return ctx;
    }

    const repeatCount = countConsecutiveMatchingTurns({
      history: ctx.history,
      userContent: ctx.effectiveUserContent,
      resultText,
    });
    if (repeatCount < GATEWAY_TURN_LOOP_WARNING_THRESHOLD) {
      return ctx;
    }

    const action =
      repeatCount >= GATEWAY_TURN_LOOP_FORCE_STOP_THRESHOLD
        ? 'force-stop'
        : 'warn';
    const note =
      action === 'force-stop'
        ? `${GATEWAY_TURN_LOOP_GUARD_PREFIX} Similar turn output repeated ${repeatCount} times. Stopping autonomous continuation until a fresh user intervention changes the approach.`
        : `${GATEWAY_TURN_LOOP_WARNING_PREFIX} Similar turn output repeated ${repeatCount} times. Change tactic instead of repeating the same response.`;
    const nextResultText = `${stripGatewayTurnLoopNotice(resultText)}\n\n${note}`;
    if (action === 'force-stop' && isFullAutoEnabled(ctx.session)) {
      await disableFullAutoSession({
        sessionId: ctx.session.id,
        reason: 'Loop guard triggered.',
      });
    }

    return {
      ...ctx,
      ...buildGatewaySuccessResultState({
        request: ctx.request,
        output: ctx.output,
        pluginsUsed: ctx.pluginsUsed,
        toolExecutions: ctx.toolExecutions,
        userContent: ctx.effectiveUserContent,
        resultText: nextResultText,
      }),
      turnLoopRepeatCount: repeatCount,
      turnLoopAction: action,
    };
  }
}

class PersistenceMiddleware {
  readonly name = 'persistence';

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayCompletedContext,
  ): Promise<GatewayCompletedContext> {
    const resultText = String(ctx.resultText || '').trim();
    if (ctx.finalResult.status !== 'success' || !resultText) {
      return ctx;
    }

    this.deps.recordSuccessfulTurn({
      sessionId: ctx.request.sessionId,
      agentId: ctx.agentId,
      chatbotId: ctx.chatbotId,
      enableRag: ctx.enableRag,
      model: ctx.model,
      channelId: ctx.request.channelId,
      runId: ctx.runId,
      turnIndex: ctx.turnIndex,
      userId: ctx.request.userId,
      username: ctx.request.username,
      canonicalScopeId: ctx.canonicalContextScope,
      userContent: ctx.effectiveUserContent,
      resultText,
      toolCallCount: ctx.toolExecutions.length,
      startedAt: ctx.startedAt,
    });
    return ctx;
  }
}

class SideEffectsMiddleware {
  readonly name = 'side-effects';

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayCompletedContext,
  ): Promise<GatewayCompletedContext> {
    if (ctx.clarificationRequested || ctx.turnLoopAction === 'force-stop') {
      return ctx;
    }

    const parentDepth = this.deps.extractDelegationDepth(ctx.request.sessionId);
    let acceptedDelegations = 0;
    processSideEffects(
      ctx.output,
      ctx.request.sessionId,
      ctx.request.channelId,
      {
        onDelegation: (effect: DelegationSideEffect) => {
          const normalized = this.deps.normalizeDelegationEffect(
            effect,
            ctx.model,
          );
          if (!normalized.plan) {
            logger.warn(
              {
                sessionId: ctx.request.sessionId,
                error: normalized.error || 'unknown',
                effect,
              },
              'Delegation skipped — invalid payload',
            );
            return;
          }

          const childDepth = parentDepth + 1;
          if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
            logger.info(
              {
                sessionId: ctx.request.sessionId,
                childDepth,
                maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH,
              },
              'Delegation skipped — depth limit reached',
            );
            return;
          }

          const requestedRuns = normalized.plan.tasks.length;
          if (
            acceptedDelegations + requestedRuns >
            PROACTIVE_DELEGATION_MAX_PER_TURN
          ) {
            logger.info(
              {
                sessionId: ctx.request.sessionId,
                limit: PROACTIVE_DELEGATION_MAX_PER_TURN,
                requestedRuns,
                acceptedDelegations,
              },
              'Delegation skipped — per-turn limit reached',
            );
            return;
          }
          acceptedDelegations += requestedRuns;
          this.deps.enqueueDelegationFromSideEffect({
            plan: normalized.plan,
            parentSessionId: ctx.request.sessionId,
            channelId: ctx.request.channelId,
            chatbotId: ctx.chatbotId,
            enableRag: ctx.enableRag,
            agentId: ctx.agentId,
            onProactiveMessage: ctx.request.onProactiveMessage,
            parentDepth,
          });
        },
      },
    );

    return ctx;
  }
}

class PluginLifecycleMiddleware {
  readonly name = 'plugin-lifecycle';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayCompletedContext,
  ): Promise<GatewayCompletedContext> {
    if (
      !ctx.pluginManager ||
      ctx.output.status === 'error' ||
      !ctx.storedTurnMessages
    ) {
      return ctx;
    }

    const resultText = ctx.resultText || 'No response from agent.';

    void ctx.pluginManager
      .notifyTurnComplete({
        sessionId: ctx.request.sessionId,
        userId: ctx.request.userId,
        agentId: ctx.agentId,
        messages: ctx.storedTurnMessages,
      })
      .catch((error) => {
        logger.warn(
          { sessionId: ctx.request.sessionId, agentId: ctx.agentId, error },
          'Plugin turn-complete hooks failed',
        );
      });
    void ctx.pluginManager
      .notifyAgentEnd({
        sessionId: ctx.request.sessionId,
        userId: ctx.request.userId,
        agentId: ctx.agentId,
        channelId: ctx.request.channelId,
        messages: ctx.storedTurnMessages,
        resultText,
        toolNames: ctx.toolExecutions.map((execution) => execution.name),
        model: ctx.model || undefined,
        durationMs: ctx.durationMs,
        tokenUsage: ctx.output.tokenUsage
          ? {
              promptTokens: ctx.output.tokenUsage.apiUsageAvailable
                ? ctx.output.tokenUsage.apiPromptTokens
                : ctx.output.tokenUsage.estimatedPromptTokens,
              completionTokens: ctx.output.tokenUsage.apiUsageAvailable
                ? ctx.output.tokenUsage.apiCompletionTokens
                : ctx.output.tokenUsage.estimatedCompletionTokens,
              totalTokens: ctx.output.tokenUsage.apiUsageAvailable
                ? ctx.output.tokenUsage.apiTotalTokens
                : ctx.output.tokenUsage.estimatedTotalTokens,
              modelCalls: ctx.output.tokenUsage.modelCalls,
            }
          : undefined,
      })
      .catch((error) => {
        logger.warn(
          { sessionId: ctx.request.sessionId, agentId: ctx.agentId, error },
          'Plugin agent-end hooks failed',
        );
      });

    return ctx;
  }
}

class FinalizeResponseMiddleware {
  readonly name = 'finalize-response';

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayCompletedContext,
  ): Promise<GatewayCompletedContext> {
    if (
      ctx.finalResult.status === 'success' &&
      !ctx.clarificationRequested &&
      ctx.turnLoopAction !== 'force-stop'
    ) {
      maybeScheduleFullAutoAfterSuccess({
        session: ctx.session,
        req: ctx.request,
        result: ctx.finalResult,
      });
    }

    if (Array.isArray(ctx.requestMessages)) {
      this.deps.maybeRecordGatewayRequestLog({
        sessionId: ctx.request.sessionId,
        model: ctx.model,
        chatbotId: ctx.chatbotId,
        messages: ctx.requestMessages,
        status: ctx.finalResult.status,
        response:
          ctx.finalResult.status === 'success'
            ? ctx.finalResult.result
            : undefined,
        error:
          ctx.finalResult.status === 'error'
            ? ctx.finalResult.error
            : undefined,
        toolExecutions: ctx.toolExecutions,
        toolsUsed: ctx.output.toolsUsed || [],
        durationMs: ctx.durationMs,
      });
    }

    return ctx;
  }
}

export class GatewayChatMiddlewareRunner {
  private readonly session: SessionMiddleware;
  private readonly media: MediaProcessingMiddleware;
  private readonly memory: MemoryMiddleware;
  private readonly promptAssembly: PromptAssemblyMiddleware;
  private readonly audit: AuditMiddleware;
  private readonly modelLifecycle: ModelLifecycleMiddleware;
  private readonly toolAnalysis: ToolAnalysisMiddleware;
  private readonly completion: CompletionMiddleware;
  private readonly clarification: ClarificationMiddleware;
  private readonly loopDetection: GatewayLoopDetectionMiddleware;
  private readonly persistence: PersistenceMiddleware;
  private readonly sideEffects: SideEffectsMiddleware;
  private readonly pluginLifecycle: PluginLifecycleMiddleware;
  private readonly finalizeResponse: FinalizeResponseMiddleware;

  constructor(deps: GatewayMiddlewareDependencies) {
    this.session = new SessionMiddleware(deps);
    this.media = new MediaProcessingMiddleware();
    this.memory = new MemoryMiddleware(deps);
    this.promptAssembly = new PromptAssemblyMiddleware();
    this.audit = new AuditMiddleware();
    this.modelLifecycle = new ModelLifecycleMiddleware();
    this.toolAnalysis = new ToolAnalysisMiddleware();
    this.completion = new CompletionMiddleware();
    this.clarification = new ClarificationMiddleware();
    this.loopDetection = new GatewayLoopDetectionMiddleware();
    this.persistence = new PersistenceMiddleware(deps);
    this.sideEffects = new SideEffectsMiddleware(deps);
    this.pluginLifecycle = new PluginLifecycleMiddleware();
    this.finalizeResponse = new FinalizeResponseMiddleware(deps);
  }

  async runBeforeAgent(
    ctx: GatewayChatChainInput,
  ): Promise<GatewayPromptPreparedContext> {
    const sessionContext = await runGatewayPhaseStep(
      this.session,
      'beforeAgent',
      ctx,
      (value) => this.session.beforeAgent(value),
    );
    const mediaContext = await runGatewayPhaseStep(
      this.media,
      'beforeAgent',
      sessionContext,
      (value) => this.media.beforeAgent(value),
    );
    const memoryContext = await runGatewayPhaseStep(
      this.memory,
      'beforeAgent',
      mediaContext,
      (value) => this.memory.beforeAgent(value),
    );
    const promptContext = await runGatewayPhaseStep(
      this.promptAssembly,
      'beforeAgent',
      memoryContext,
      (value) => this.promptAssembly.beforeAgent(value),
    );
    return await runGatewayPhaseStep(
      this.audit,
      'beforeAgent',
      promptContext,
      (value) => this.audit.beforeAgent(value),
    );
  }

  async runBeforeModel(
    ctx: GatewayModelInvocationContext,
  ): Promise<GatewayModelInvocationContext> {
    return await runGatewayPhaseStep(
      this.modelLifecycle,
      'beforeModel',
      ctx,
      (value) => this.modelLifecycle.beforeModel(value),
    );
  }

  async runAfterModel(
    ctx: GatewayRawModelOutputContext,
  ): Promise<GatewayModelOutputContext> {
    return await runGatewayPhaseStep(
      this.modelLifecycle,
      'afterModel',
      ctx,
      (value) => this.modelLifecycle.afterModel(value),
    );
  }

  async runAfterAgent(
    ctx: GatewayModelOutputContext,
  ): Promise<GatewayCompletedContext> {
    const analyzedContext = await runGatewayPhaseStep(
      this.toolAnalysis,
      'afterAgent',
      ctx,
      (value) => this.toolAnalysis.afterAgent(value),
    );
    let completedContext = await runGatewayPhaseStep(
      this.completion,
      'afterAgent',
      analyzedContext,
      (value) => this.completion.afterAgent(value),
    );
    completedContext = await runGatewayPhaseStep(
      this.clarification,
      'afterAgent',
      completedContext,
      (value) => this.clarification.afterAgent(value),
    );
    completedContext = await runGatewayPhaseStep(
      this.loopDetection,
      'afterAgent',
      completedContext,
      (value) => this.loopDetection.afterAgent(value),
    );
    completedContext = await runGatewayPhaseStep(
      this.persistence,
      'afterAgent',
      completedContext,
      (value) => this.persistence.afterAgent(value),
    );
    completedContext = await runGatewayPhaseStep(
      this.sideEffects,
      'afterAgent',
      completedContext,
      (value) => this.sideEffects.afterAgent(value),
    );
    completedContext = await runGatewayPhaseStep(
      this.pluginLifecycle,
      'afterAgent',
      completedContext,
      (value) => this.pluginLifecycle.afterAgent(value),
    );
    return await runGatewayPhaseStep(
      this.finalizeResponse,
      'afterAgent',
      completedContext,
      (value) => this.finalizeResponse.afterAgent(value),
    );
  }
}

export function buildGatewayMiddlewareChain(
  _config: RuntimeConfig,
  deps: GatewayMiddlewareDependencies,
): GatewayChatMiddlewareRunner {
  return new GatewayChatMiddlewareRunner(deps);
}

function stripGatewayTurnLoopNotice(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(GATEWAY_TURN_LOOP_WARNING_PREFIX) &&
        !trimmed.startsWith(GATEWAY_TURN_LOOP_GUARD_PREFIX)
      );
    })
    .join('\n')
    .trim();
}

function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
