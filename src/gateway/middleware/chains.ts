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
import { MiddlewareChain } from '../../middleware/chain.js';
import type {
  MiddlewareResult,
  ToolMiddlewareContext,
} from '../../middleware/types.js';
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
  GatewayChainMiddleware,
  GatewayCommandChainMiddleware,
  GatewayCommandMiddlewareContext,
  GatewayCommandMiddlewareState,
  GatewayMiddlewareContext,
  GatewayMiddlewareDependencies,
  GatewayMiddlewareState,
  GatewayPluginToolChainMiddleware,
  GatewayPluginToolMiddlewareContext,
  GatewayPluginToolMiddlewareState,
  GatewayScheduledTaskChainMiddleware,
  GatewayScheduledTaskMiddlewareContext,
  GatewayScheduledTaskMiddlewareState,
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
// Plugin prompt recall owns its own timeout budget.
const GATEWAY_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS = 0;

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

class CommandSessionMiddleware implements GatewayCommandChainMiddleware {
  readonly name = 'command-session';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_SESSION_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayCommandMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayCommandMiddlewareState>;
  }> {
    const session = await this.deps.prepareGatewaySessionRecord({
      request: ctx.request,
      pluginManager: ctx.state.pluginManager,
    });
    return {
      stateUpdates: {
        session,
      },
    };
  }
}

class PluginToolSessionMiddleware implements GatewayPluginToolChainMiddleware {
  readonly name = 'plugin-tool-session';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_SESSION_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayPluginToolMiddlewareContext): Promise<{
    stateUpdates?: Partial<GatewayPluginToolMiddlewareState>;
  }> {
    const sessionId = String(ctx.request.sessionId || '').trim();
    const channelId = String(ctx.request.channelId || '').trim();
    if (!sessionId || !channelId) {
      return {};
    }
    const session = await this.deps.prepareGatewaySessionRecord({
      request: ctx.request,
      pluginManager: ctx.state.pluginManager,
    });
    return {
      stateUpdates: {
        session,
      },
    };
  }
}

class ScheduledTaskSessionMiddleware
  implements GatewayScheduledTaskChainMiddleware
{
  readonly name = 'scheduled-task-session';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_SESSION_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayScheduledTaskMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayScheduledTaskMiddlewareState>;
  }> {
    const session = await this.deps.prepareGatewaySessionRecord({
      request: ctx.request,
      pluginManager: ctx.state.pluginManager,
      sessionResetPolicy: {
        ...resolveSessionResetPolicy(ctx.config, ctx.request.channelId),
        mode: 'none',
      },
    });
    return {
      stateUpdates: {
        session,
      },
    };
  }
}

class SessionMiddleware implements GatewayChainMiddleware {
  readonly name = 'session';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_SESSION_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayMiddlewareState>;
  }> {
    const req = ctx.request;
    const pluginManager = ctx.state.pluginManager;
    const sessionResetPolicy = resolveSessionResetPolicy(
      ctx.config,
      req.channelId,
    );
    let session = await this.deps.prepareGatewaySessionRecord({
      request: req,
      pluginManager,
    });

    if (ctx.state.source !== 'fullauto') {
      preemptRunningFullAutoTurn(req.sessionId, ctx.state.source);
      clearScheduledFullAutoContinuation(req.sessionId);
      if (isFullAutoEnabled(session)) {
        noteFullAutoSupervisedIntervention({
          session,
          content: req.content,
          source: ctx.state.source,
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
      if (reboundSession) {
        const previousSessionId = req.sessionId;
        req.sessionId = reboundSession.id;
        if (pluginManager) {
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
      if (pluginManager) {
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
    if (turnIndex === 1 && pluginManager) {
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
      stateUpdates: {
        session,
        agentId,
        model,
        chatbotId,
        enableRag,
        provider,
        channelType,
        channel,
        sessionContext,
        shouldEmitTools,
        workspacePath,
        canonicalContextScope,
        turnIndex,
      },
    };
  }
}

class MediaProcessingMiddleware implements GatewayChainMiddleware {
  readonly name = 'media-processing';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_MEDIA_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayMiddlewareState>;
  }> {
    const workspacePath = String(ctx.state.workspacePath || '').trim();
    if (!workspacePath) {
      throw new Error('Media middleware requires workspacePath.');
    }

    const media = normalizeMediaContextItems(ctx.request.media);
    const audioPrelude = await prependAudioTranscriptionsToUserContent({
      content: ctx.request.content,
      media,
      workspaceRoot: workspacePath,
      abortSignal: ctx.state.abortSignal,
    });
    const userTurnContent = audioPrelude.content;

    return {
      stateUpdates: {
        media,
        mediaPolicy: resolveMediaToolPolicy(userTurnContent, media),
        userTurnContent,
        audioTranscriptCount: audioPrelude.transcripts.length,
      },
    };
  }
}

class MemoryMiddleware implements GatewayChainMiddleware {
  readonly name = 'memory';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_MEMORY_MIDDLEWARE_TIMEOUT_MS,
  } as const;

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayMiddlewareState>;
  }> {
    const session = ctx.state.session;
    const agentId = String(ctx.state.agentId || '').trim();
    const userTurnContent = String(ctx.state.userTurnContent || '').trim();
    if (!session || !agentId) {
      throw new Error('Memory middleware requires session and agentId.');
    }

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
    const canonicalContextScope = String(
      ctx.state.canonicalContextScope || '',
    ).trim();
    if (canonicalContextScope) {
      try {
        canonicalContext = memoryService.getCanonicalContext({
          agentId,
          userId: canonicalContextScope,
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
          { sessionId: ctx.request.sessionId, canonicalContextScope, err },
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
      content: userTurnContent,
      created_at: new Date(ctx.state.startedAt).toISOString(),
    });
    const pluginManager = ctx.state.pluginManager;
    const pluginPromptDetails = pluginManager
      ? await runBestEffortPluginPreparation({
          sessionId: ctx.request.sessionId,
          channelId: ctx.request.channelId,
          agentId,
          label: 'Plugin prompt context collection',
          timeoutMs: GATEWAY_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS,
          abortSignal: ctx.state.abortSignal,
          fallback: { sections: [], pluginIds: [] },
          operation: (abortSignal) =>
            pluginManager.collectPromptContextDetails({
              sessionId: ctx.request.sessionId,
              userId: ctx.request.userId,
              agentId,
              channelId: ctx.request.channelId,
              recentMessages: pluginRecentMessages,
              abortSignal,
            }),
          warningMessage:
            'Plugin prompt context collection failed during gateway session preparation',
        })
      : { sections: [], pluginIds: [] };
    pluginsUsed = pluginPromptDetails.pluginIds;
    const pluginPromptSummary = formatPluginPromptContext(
      pluginPromptDetails.sections,
    );
    const memoryContext = memoryService.buildPromptMemoryContext({
      session,
      query: userTurnContent,
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
      stateUpdates: {
        history,
        mergedSessionSummary,
        pluginPromptSummary,
        canonicalPromptSummary,
        canonicalRecentMessagesIncluded:
          canonicalContext.recent_messages.length,
        pluginsUsed,
        memoryContext,
      },
    };
  }
}

class PromptAssemblyMiddleware implements GatewayChainMiddleware {
  readonly name = 'prompt-assembly';
  readonly timeoutsMs = {
    beforeAgent: GATEWAY_PROMPT_ASSEMBLY_TIMEOUT_MS,
  } as const;

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayMiddlewareContext): Promise<{
    messages: ChatMessage[];
    stateUpdates: Partial<GatewayMiddlewareState>;
  }> {
    const session = ctx.state.session;
    const agentId = String(ctx.state.agentId || '').trim();
    const model = String(ctx.state.model || '').trim();
    const userTurnContent = String(ctx.state.userTurnContent || '').trim();
    const workspacePath = String(ctx.state.workspacePath || '').trim();
    const history = ctx.state.history || [];
    const media = ctx.state.media || [];
    const mediaPolicy = ctx.state.mediaPolicy || {
      blockedTools: undefined,
      prioritizeVisionTool: false,
    };
    if (!session || !agentId || !model || !workspacePath) {
      throw new Error(
        'Prompt assembly middleware requires session, agentId, model, and workspacePath.',
      );
    }

    const fullAutoOperatingContract = isFullAutoEnabled(session)
      ? buildFullAutoOperatingContract(
          session,
          ctx.state.source === 'fullauto' ? 'background' : 'supervised',
        )
      : undefined;
    const promptContext = assembleConversationPromptContext({
      agentId,
      sessionSummary: ctx.state.mergedSessionSummary,
      retrievedContext: ctx.state.pluginPromptSummary,
      history,
      currentUserContent: userTurnContent,
      promptMode: 'full',
      extraSafetyText: fullAutoOperatingContract,
      runtimeInfo: {
        chatbotId: ctx.state.chatbotId || undefined,
        model,
        defaultModel: HYBRIDAI_MODEL,
        channel: ctx.state.channel,
        channelType: ctx.state.channelType,
        channelId: ctx.request.channelId,
        guildId: ctx.request.guildId,
        sessionContext: ctx.state.sessionContext,
        workspacePath,
      },
      blockedTools: mediaPolicy.blockedTools,
    });
    const mediaContextBlock = buildMediaPromptContext(media);
    const expandedUserContent = promptContext.currentUserContent;
    const agentUserContent = mediaContextBlock
      ? `${expandedUserContent}\n\n${mediaContextBlock}`
      : expandedUserContent;
    const promptMessages = [
      ...promptContext.messages,
      {
        role: 'user' as const,
        content: agentUserContent,
      },
    ];

    return {
      messages: promptMessages,
      stateUpdates: {
        explicitSkillName: promptContext.explicitSkillName,
        requestMessages: ctx.state.requestLoggingEnabled
          ? promptMessages.slice()
          : null,
        historyStats: promptContext.historyStats,
        historyLength: history.length,
        skillCount: promptContext.skills.length,
        skills: promptContext.skills,
      },
    };
  }
}

class AuditMiddleware implements GatewayChainMiddleware {
  readonly name = 'audit';

  isEnabled(): boolean {
    return true;
  }

  async beforeAgent(ctx: GatewayMiddlewareContext): Promise<{
    stateUpdates?: Partial<GatewayMiddlewareState>;
  }> {
    const session = ctx.state.session;
    const model = String(ctx.state.model || '').trim();
    const workspacePath = String(ctx.state.workspacePath || '').trim();
    const userTurnContent = String(ctx.state.userTurnContent || '');
    const turnIndex = Number(ctx.state.turnIndex || 0);
    const media = ctx.state.media || [];
    const historyStats = ctx.state.historyStats;
    if (
      !session ||
      !model ||
      !workspacePath ||
      !historyStats ||
      turnIndex <= 0
    ) {
      throw new Error('Audit middleware requires prepared session context.');
    }

    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.state.runId,
      event: {
        type: 'session.start',
        userId: ctx.request.userId,
        channel: ctx.request.channelId,
        cwd: workspacePath,
        model,
        source: ctx.state.source,
      },
    });
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.state.runId,
      event: {
        type: 'turn.start',
        turnIndex,
        userInput: userTurnContent,
        ...(userTurnContent !== ctx.request.content
          ? { rawUserInput: ctx.request.content }
          : {}),
        username: ctx.request.username,
        mediaCount: media.length,
        source: ctx.state.source,
      },
    });

    const historyStart =
      ctx.messages.length > 0 && ctx.messages[0]?.role === 'system' ? 1 : 0;
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.state.runId,
      event: {
        type: 'context.optimization',
        historyMessagesOriginal: historyStats.originalCount,
        historyMessagesIncluded: historyStats.includedCount,
        historyMessagesDropped: historyStats.droppedCount,
        historyCharsOriginal: historyStats.originalChars,
        historyCharsPreBudget: historyStats.preBudgetChars,
        historyCharsIncluded: historyStats.includedChars,
        historyCharsDropped: historyStats.droppedChars,
        historyMaxChars: historyStats.maxTotalChars,
        historyMaxMessageChars: historyStats.maxMessageChars,
        perMessageTruncatedCount: historyStats.perMessageTruncatedCount,
        middleCompressionApplied: historyStats.middleCompressionApplied,
        historyEstimatedTokens: estimateTokenCountFromMessages(
          ctx.messages.slice(historyStart),
        ),
        canonicalSummaryIncluded: Boolean(ctx.state.canonicalPromptSummary),
        canonicalRecentMessagesIncluded:
          ctx.state.canonicalRecentMessagesIncluded || 0,
      },
    });

    return {};
  }
}

class ToolAnalysisMiddleware implements GatewayChainMiddleware {
  readonly name = 'tool-analysis';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(ctx: GatewayMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayMiddlewareState>;
  }> {
    const output = ctx.state.output;
    const provider = ctx.state.provider;
    const model = String(ctx.state.model || '').trim();
    const agentId = String(ctx.state.agentId || '').trim();
    const durationMs = Number(ctx.state.durationMs || 0);
    if (!output || !provider || !model || !agentId) {
      throw new Error('Tool analysis middleware requires agent output state.');
    }

    const effectiveUserContent =
      typeof output.effectiveUserPrompt === 'string' &&
      output.effectiveUserPrompt.trim()
        ? output.effectiveUserPrompt.trim()
        : String(ctx.state.userTurnContent || '');
    const toolExecutions = output.toolExecutions || [];
    const observedSkillName = resolveObservedSkillName({
      explicitSkillName: ctx.state.explicitSkillName || null,
      toolExecutions,
      skills: ctx.state.skills || [],
    });
    emitToolExecutionAuditEvents({
      sessionId: ctx.request.sessionId,
      runId: ctx.state.runId,
      toolExecutions,
    });
    const usagePayload = buildTokenUsageAuditPayload(
      ctx.messages,
      output.result,
      output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: ctx.request.sessionId,
      runId: ctx.state.runId,
      event: {
        type: 'model.usage',
        provider,
        model,
        durationMs,
        toolCallCount: toolExecutions.length,
        ...usagePayload,
      },
    });
    recordUsageEvent({
      sessionId: ctx.request.sessionId,
      agentId,
      model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: toolExecutions.length,
      costUsd: extractUsageCostUsd(output.tokenUsage),
    });
    if (observedSkillName) {
      try {
        recordSkillExecution({
          skillName: observedSkillName,
          sessionId: ctx.request.sessionId,
          runId: ctx.state.runId,
          toolExecutions,
          outcome: deriveSkillExecutionOutcome({
            outputStatus: output.status,
            toolExecutions,
          }),
          durationMs,
          errorDetail: output.error,
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

    let nextOutput = output;
    let resultText: string | undefined;
    if (output.status !== 'error') {
      resultText = output.result || 'No response from agent.';
      const memoryCitations = extractMemoryCitations(
        resultText,
        ctx.state.memoryContext?.citationIndex || [],
      );
      if (memoryCitations.length > 0) {
        nextOutput = {
          ...output,
          memoryCitations,
        };
      }
    }

    return {
      stateUpdates: {
        output: nextOutput,
        effectiveUserContent,
        toolExecutions,
        observedSkillName,
        usagePayload,
        ...(typeof resultText === 'string' ? { resultText } : {}),
        ...(output.status === 'error'
          ? { errorMessage: output.error || 'Unknown agent error.' }
          : {}),
      },
    };
  }
}

class SideEffectsMiddleware implements GatewayChainMiddleware {
  readonly name = 'side-effects';

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayMiddlewareContext,
  ): Promise<MiddlewareResult<GatewayMiddlewareState>> {
    const output = ctx.state.output;
    const model = String(ctx.state.model || '').trim();
    const chatbotId = String(ctx.state.chatbotId || '').trim();
    const agentId = String(ctx.state.agentId || '').trim();
    if (!output || !model || !agentId) {
      throw new Error('Side-effects middleware requires prepared agent state.');
    }
    if (
      ctx.state.clarificationRequested ||
      ctx.state.turnLoopAction === 'force-stop'
    ) {
      return {};
    }

    const parentDepth = this.deps.extractDelegationDepth(ctx.request.sessionId);
    let acceptedDelegations = 0;
    processSideEffects(output, ctx.request.sessionId, ctx.request.channelId, {
      onDelegation: (effect: DelegationSideEffect) => {
        const normalized = this.deps.normalizeDelegationEffect(effect, model);
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
          chatbotId,
          enableRag: ctx.state.enableRag === true,
          agentId,
          onProactiveMessage: ctx.request.onProactiveMessage,
          parentDepth,
        });
      },
    });

    return {};
  }
}

class CompletionMiddleware implements GatewayChainMiddleware {
  readonly name = 'completion';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(ctx: GatewayMiddlewareContext): Promise<{
    stateUpdates: Partial<GatewayMiddlewareState>;
  }> {
    const output = ctx.state.output;
    const session = ctx.state.session;
    const agentId = String(ctx.state.agentId || '').trim();
    const model = String(ctx.state.model || '').trim();
    const durationMs = Number(ctx.state.durationMs || 0);
    const toolExecutions = ctx.state.toolExecutions || [];
    const firstTextDeltaMs = ctx.state.firstTextDeltaMs ?? null;
    if (!output || !session || !agentId || !model) {
      throw new Error(
        'Completion middleware requires prepared post-agent state.',
      );
    }

    if (output.status === 'error') {
      const errorMessage = ctx.state.errorMessage || 'Unknown agent error.';
      logger.debug(
        {
          sessionId: ctx.request.sessionId,
          guildId: ctx.request.guildId,
          channelId: ctx.request.channelId,
          userId: ctx.request.userId,
          model,
          provider: ctx.state.provider,
          turnIndex: ctx.state.turnIndex,
          mediaCount: ctx.state.media?.length || 0,
          audioTranscriptCount: ctx.state.audioTranscriptCount || 0,
          contentLength: String(ctx.state.userTurnContent || '').length,
          streamingRequested: Boolean(
            ctx.request.onTextDelta ||
              ctx.request.onToolProgress ||
              ctx.request.onApprovalProgress,
          ),
          durationMs,
          toolCallCount: toolExecutions.length,
          firstTextDeltaMs,
          artifactCount: output.artifacts?.length || 0,
        },
        'Gateway chat completed with agent error',
      );
      recordAuditEvent({
        sessionId: ctx.request.sessionId,
        runId: ctx.state.runId,
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
        runId: ctx.state.runId,
        event: {
          type: 'turn.end',
          turnIndex: Number(ctx.state.turnIndex || 0),
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId: ctx.request.sessionId,
        runId: ctx.state.runId,
        event: {
          type: 'session.end',
          reason: 'error',
          stats: {
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: toolExecutions.length,
            durationMs,
          },
        },
      });
      return {
        stateUpdates: {
          finalResult: {
            status: 'error',
            result: null,
            toolsUsed: output.toolsUsed || [],
            pluginsUsed: ctx.state.pluginsUsed,
            artifacts: output.artifacts,
            toolExecutions,
            tokenUsage: output.tokenUsage,
            error: errorMessage,
          },
        },
      };
    }

    const resultText = ctx.state.resultText || 'No response from agent.';
    logger.debug(
      {
        sessionId: ctx.request.sessionId,
        guildId: ctx.request.guildId,
        channelId: ctx.request.channelId,
        userId: ctx.request.userId,
        model,
        provider: ctx.state.provider,
        turnIndex: ctx.state.turnIndex,
        mediaCount: ctx.state.media?.length || 0,
        audioTranscriptCount: ctx.state.audioTranscriptCount || 0,
        contentLength: String(ctx.state.userTurnContent || '').length,
        streamingRequested: Boolean(
          ctx.request.onTextDelta ||
            ctx.request.onToolProgress ||
            ctx.request.onApprovalProgress,
        ),
        durationMs,
        toolCallCount: toolExecutions.length,
        firstTextDeltaMs,
        artifactCount: output.artifacts?.length || 0,
      },
      'Gateway chat completed successfully',
    );
    return {
      stateUpdates: {
        ...buildGatewaySuccessResultState({
          request: ctx.request,
          output,
          pluginsUsed: ctx.state.pluginsUsed,
          toolExecutions,
          userContent:
            ctx.state.effectiveUserContent ||
            String(ctx.state.userTurnContent || ''),
          resultText,
        }),
      },
    };
  }
}

class ClarificationMiddleware implements GatewayChainMiddleware {
  readonly name = 'clarification';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayMiddlewareContext,
  ): Promise<MiddlewareResult<GatewayMiddlewareState>> {
    const finalResult = ctx.state.finalResult;
    if (finalResult?.status !== 'success' || !ctx.state.resultText) {
      return {};
    }
    if (!isClarificationRequest(ctx.state.resultText)) {
      return {};
    }
    return {
      stateUpdates: {
        clarificationRequested: true,
      },
    };
  }
}

class GatewayLoopDetectionMiddleware implements GatewayChainMiddleware {
  readonly name = 'gateway-loop-detection';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayMiddlewareContext,
  ): Promise<MiddlewareResult<GatewayMiddlewareState>> {
    const session = ctx.state.session;
    const output = ctx.state.output;
    const finalResult = ctx.state.finalResult;
    const resultText = String(ctx.state.resultText || '').trim();
    if (
      !session ||
      !output ||
      finalResult?.status !== 'success' ||
      !resultText ||
      ctx.state.clarificationRequested
    ) {
      return {};
    }
    if (ctx.state.source !== 'fullauto' && !isFullAutoEnabled(session)) {
      return {};
    }

    const repeatCount = countConsecutiveMatchingTurns({
      history: ctx.state.history || [],
      userContent:
        ctx.state.effectiveUserContent ||
        String(ctx.state.userTurnContent || ''),
      resultText,
    });
    if (repeatCount < GATEWAY_TURN_LOOP_WARNING_THRESHOLD) {
      return {};
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
    if (action === 'force-stop' && isFullAutoEnabled(session)) {
      await disableFullAutoSession({
        sessionId: session.id,
        reason: 'Loop guard triggered.',
      });
    }

    return {
      stateUpdates: {
        turnLoopRepeatCount: repeatCount,
        turnLoopAction: action,
        ...buildGatewaySuccessResultState({
          request: ctx.request,
          output,
          pluginsUsed: ctx.state.pluginsUsed,
          toolExecutions: ctx.state.toolExecutions || [],
          userContent:
            ctx.state.effectiveUserContent ||
            String(ctx.state.userTurnContent || ''),
          resultText: nextResultText,
        }),
      },
    };
  }
}

class PersistenceMiddleware implements GatewayChainMiddleware {
  readonly name = 'persistence';

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayMiddlewareContext,
  ): Promise<MiddlewareResult<GatewayMiddlewareState>> {
    const finalResult = ctx.state.finalResult;
    const session = ctx.state.session;
    const agentId = String(ctx.state.agentId || '').trim();
    const chatbotId = String(ctx.state.chatbotId || '').trim();
    const model = String(ctx.state.model || '').trim();
    const resultText = String(ctx.state.resultText || '').trim();
    const toolExecutions = ctx.state.toolExecutions || [];
    if (
      finalResult?.status !== 'success' ||
      !session ||
      !agentId ||
      !model ||
      !resultText
    ) {
      return {};
    }

    this.deps.recordSuccessfulTurn({
      sessionId: ctx.request.sessionId,
      agentId,
      chatbotId,
      enableRag: ctx.state.enableRag === true,
      model,
      channelId: ctx.request.channelId,
      runId: ctx.state.runId,
      turnIndex: Number(ctx.state.turnIndex || 0),
      userId: ctx.request.userId,
      username: ctx.request.username,
      canonicalScopeId: String(ctx.state.canonicalContextScope || ''),
      userContent:
        ctx.state.effectiveUserContent ||
        String(ctx.state.userTurnContent || ''),
      resultText,
      toolCallCount: toolExecutions.length,
      startedAt: ctx.state.startedAt,
    });
    return {};
  }
}

class PluginLifecycleMiddleware implements GatewayChainMiddleware {
  readonly name = 'plugin-lifecycle';

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayMiddlewareContext,
  ): Promise<MiddlewareResult<GatewayMiddlewareState>> {
    const pluginManager = ctx.state.pluginManager;
    const output = ctx.state.output;
    const storedTurnMessages = ctx.state.storedTurnMessages;
    const agentId = String(ctx.state.agentId || '').trim();
    const model = String(ctx.state.model || '').trim();
    if (
      !pluginManager ||
      !output ||
      output.status === 'error' ||
      !storedTurnMessages ||
      !agentId
    ) {
      return {};
    }

    const resultText = ctx.state.resultText || 'No response from agent.';
    const toolExecutions = ctx.state.toolExecutions || [];
    const durationMs = Number(ctx.state.durationMs || 0);

    void pluginManager
      .notifyTurnComplete({
        sessionId: ctx.request.sessionId,
        userId: ctx.request.userId,
        agentId,
        messages: storedTurnMessages,
      })
      .catch((error) => {
        logger.warn(
          { sessionId: ctx.request.sessionId, agentId, error },
          'Plugin turn-complete hooks failed',
        );
      });
    void pluginManager
      .notifyAgentEnd({
        sessionId: ctx.request.sessionId,
        userId: ctx.request.userId,
        agentId,
        channelId: ctx.request.channelId,
        messages: storedTurnMessages,
        resultText,
        toolNames: toolExecutions.map((execution) => execution.name),
        model: model || undefined,
        durationMs,
        tokenUsage: output.tokenUsage
          ? {
              promptTokens: output.tokenUsage.apiUsageAvailable
                ? output.tokenUsage.apiPromptTokens
                : output.tokenUsage.estimatedPromptTokens,
              completionTokens: output.tokenUsage.apiUsageAvailable
                ? output.tokenUsage.apiCompletionTokens
                : output.tokenUsage.estimatedCompletionTokens,
              totalTokens: output.tokenUsage.apiUsageAvailable
                ? output.tokenUsage.apiTotalTokens
                : output.tokenUsage.estimatedTotalTokens,
              modelCalls: output.tokenUsage.modelCalls,
            }
          : undefined,
      })
      .catch((error) => {
        logger.warn(
          { sessionId: ctx.request.sessionId, agentId, error },
          'Plugin agent-end hooks failed',
        );
      });

    return {};
  }
}

class FinalizeResponseMiddleware implements GatewayChainMiddleware {
  readonly name = 'finalize-response';

  constructor(private readonly deps: GatewayMiddlewareDependencies) {}

  isEnabled(): boolean {
    return true;
  }

  async afterAgent(
    ctx: GatewayMiddlewareContext,
  ): Promise<MiddlewareResult<GatewayMiddlewareState>> {
    const finalResult = ctx.state.finalResult;
    const session = ctx.state.session;
    const requestMessages = ctx.state.requestMessages;
    const model = String(ctx.state.model || '').trim();
    const chatbotId = String(ctx.state.chatbotId || '').trim();
    const output = ctx.state.output;
    const durationMs = Number(ctx.state.durationMs || 0);
    if (!finalResult || !session || !output || !model) {
      throw new Error(
        'Finalize response middleware requires final result state.',
      );
    }

    if (
      finalResult.status === 'success' &&
      !ctx.state.clarificationRequested &&
      ctx.state.turnLoopAction !== 'force-stop'
    ) {
      maybeScheduleFullAutoAfterSuccess({
        session,
        req: ctx.request,
        result: finalResult,
      });
    }

    if (Array.isArray(requestMessages)) {
      this.deps.maybeRecordGatewayRequestLog({
        sessionId: ctx.request.sessionId,
        model,
        chatbotId,
        messages: requestMessages,
        status: finalResult.status,
        response:
          finalResult.status === 'success' ? finalResult.result : undefined,
        error: finalResult.status === 'error' ? finalResult.error : undefined,
        toolExecutions: ctx.state.toolExecutions,
        toolsUsed: output.toolsUsed || [],
        durationMs,
      });
    }

    return {};
  }
}

export function buildGatewayMiddlewareChain(
  config: RuntimeConfig,
  deps: GatewayMiddlewareDependencies,
): MiddlewareChain<
  GatewayMiddlewareState,
  GatewayMiddlewareContext,
  ToolMiddlewareContext<GatewayMiddlewareState>
> {
  const middlewares: GatewayChainMiddleware[] = [
    new SessionMiddleware(deps),
    new MediaProcessingMiddleware(),
    new MemoryMiddleware(deps),
    new PromptAssemblyMiddleware(),
    new AuditMiddleware(),
    new ToolAnalysisMiddleware(),
    new CompletionMiddleware(),
    new ClarificationMiddleware(),
    new GatewayLoopDetectionMiddleware(),
    new PersistenceMiddleware(deps),
    new SideEffectsMiddleware(deps),
    new PluginLifecycleMiddleware(),
    new FinalizeResponseMiddleware(deps),
  ];
  return new MiddlewareChain(
    middlewares.filter((middleware) => middleware.isEnabled(config)),
  );
}

export function buildGatewayCommandMiddlewareChain(
  config: RuntimeConfig,
  deps: GatewayMiddlewareDependencies,
): MiddlewareChain<
  GatewayCommandMiddlewareState,
  GatewayCommandMiddlewareContext,
  ToolMiddlewareContext<GatewayCommandMiddlewareState>
> {
  const middlewares: GatewayCommandChainMiddleware[] = [
    new CommandSessionMiddleware(deps),
  ];
  return new MiddlewareChain(
    middlewares.filter((middleware) => middleware.isEnabled(config)),
  );
}

export function buildGatewayPluginToolMiddlewareChain(
  config: RuntimeConfig,
  deps: GatewayMiddlewareDependencies,
): MiddlewareChain<
  GatewayPluginToolMiddlewareState,
  GatewayPluginToolMiddlewareContext,
  ToolMiddlewareContext<GatewayPluginToolMiddlewareState>
> {
  const middlewares: GatewayPluginToolChainMiddleware[] = [
    new PluginToolSessionMiddleware(deps),
  ];
  return new MiddlewareChain(
    middlewares.filter((middleware) => middleware.isEnabled(config)),
  );
}

export function buildGatewayScheduledTaskMiddlewareChain(
  config: RuntimeConfig,
  deps: GatewayMiddlewareDependencies,
): MiddlewareChain<
  GatewayScheduledTaskMiddlewareState,
  GatewayScheduledTaskMiddlewareContext,
  ToolMiddlewareContext<GatewayScheduledTaskMiddlewareState>
> {
  const middlewares: GatewayScheduledTaskChainMiddleware[] = [
    new ScheduledTaskSessionMiddleware(deps),
  ];
  return new MiddlewareChain(
    middlewares.filter((middleware) => middleware.isEnabled(config)),
  );
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
