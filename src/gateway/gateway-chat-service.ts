import path from 'node:path';
import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import { processSideEffects } from '../agent/side-effects.js';
import { isSilentReply } from '../agent/silent-reply.js';
import {
  resolveAgentConfig,
  resolveAgentForRequest,
  resolveAgentModel,
} from '../agents/agent-registry.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import {
  getChannel,
  getChannelByContextId,
} from '../channels/channel-registry.js';
import {
  APP_VERSION,
  FULLAUTO_NEVER_APPROVE_TOOLS,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_MODEL,
  PROACTIVE_DELEGATION_MAX_DEPTH,
  PROACTIVE_DELEGATION_MAX_PER_TURN,
} from '../config/config.js';
import { preprocessContextReferences } from '../context-references/index.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { prependAudioTranscriptionsToUserContent } from '../media/audio-transcription.js';
import { extractMemoryCitations } from '../memory/citation-extractor.js';
import {
  createFreshSessionInstance,
  getTasksForSession,
  logAudit,
  recordUsageEvent,
} from '../memory/db.js';
import {
  type BuildMemoryPromptResult,
  memoryService,
} from '../memory/memory-service.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import { resolveSessionResetChannelKind } from '../session/session-reset.js';
import { estimateTokenCountFromMessages } from '../session/token-efficiency.js';
import {
  expandResolvedSkillInvocation,
  resolveObservedSkillName,
} from '../skills/skills.js';
import {
  deriveSkillExecutionOutcome,
  recordSkillExecution,
} from '../skills/skills-observation.js';
import type { PendingApproval, ToolProgressEvent } from '../types/execution.js';
import type { CanonicalSessionContext } from '../types/session.js';
import { ensureBootstrapFiles } from '../workspace.js';
import { buildConciergeChoiceComponents } from './concierge-choice.js';
import {
  buildConciergeExecutionNotice,
  type ConciergeProfile,
} from './concierge-routing.js';
import { resolveConciergeTurn } from './concierge-session.js';
import {
  clearScheduledFullAutoContinuation,
  isFullAutoEnabled,
  maybeScheduleFullAutoAfterSuccess,
  noteFullAutoSupervisedIntervention,
  preemptRunningFullAutoTurn,
  resolveSessionRalphIterations,
  syncFullAutoRuntimeContext,
} from './fullauto-runtime.js';
import { buildFullAutoOperatingContract } from './fullauto-workspace.js';
import { tryEnsurePluginManagerInitializedForGateway } from './gateway-plugin-runtime.js';
import { registerActiveGatewayRequest } from './gateway-request-runtime.js';
import {
  buildMediaPromptContext,
  buildStoredTurnMessages,
  buildStoredUserTurnContent,
  buildTokenUsageAuditPayload,
  cloneMediaContextItems,
  enqueueDelegationFromSideEffect,
  extractDelegationDepth,
  extractUsageCostUsd,
  formatCanonicalContextPrompt,
  formatPluginPromptContext,
  isGatewayRequestLoggingEnabled,
  isVersionOnlyQuestion,
  maybeRecordGatewayRequestLog,
  normalizeDelegationEffect,
  normalizeMediaContextItems,
  prepareSessionAutoReset,
  readSystemPromptMessage,
  recordSuccessfulTurn,
  resolveCanonicalContextScope,
  resolveChannelType,
  resolveGatewayChatbotId,
  resolveMediaToolPolicy,
  resolveSessionAutoResetPolicy,
  shouldForceNewTuiSession,
} from './gateway-service.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import { firstNumber } from './gateway-utils.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from './show-mode.js';

const MAX_HISTORY_MESSAGES = 40;

export async function handleGatewayMessage(
  req: GatewayChatRequest,
): Promise<GatewayChatResult> {
  const startedAt = Date.now();
  const { pluginManager } = await tryEnsurePluginManagerInitializedForGateway({
    sessionId: req.sessionId,
    channelId: req.channelId,
    agentId: req.agentId,
    surface: 'chat',
  });
  const pluginMemoryBehavior = pluginManager
    ? await pluginManager.getMemoryLayerBehavior()
    : { replacesBuiltInMemory: false };
  const runId = makeAuditRunId('turn');
  const source = req.source?.trim() || 'gateway.chat';
  const sessionResetPolicy = resolveSessionAutoResetPolicy(req.channelId);
  const expiryEvaluation = await prepareSessionAutoReset({
    sessionId: req.sessionId,
    channelId: req.channelId,
    agentId: req.agentId,
    chatbotId: req.chatbotId,
    model: req.model,
    enableRag: req.enableRag,
    policy: sessionResetPolicy,
  });
  const autoResetSession = memoryService.resetSessionIfExpired(req.sessionId, {
    policy: sessionResetPolicy,
    expiryEvaluation,
  });
  if (autoResetSession) {
    const previousSessionId = req.sessionId;
    req.sessionId = autoResetSession.id;
    if (pluginManager) {
      await pluginManager.handleSessionReset({
        previousSessionId,
        sessionId: req.sessionId,
        userId: req.userId,
        agentId:
          req.agentId?.trim() || autoResetSession.agent_id || DEFAULT_AGENT_ID,
        channelId: req.channelId,
        reason: 'auto-reset',
      });
    }
  }
  let session = memoryService.getOrCreateSession(
    req.sessionId,
    req.guildId,
    req.channelId,
    req.agentId ?? undefined,
    { forceNewCurrent: shouldForceNewTuiSession(req) },
  );
  if (session.id !== req.sessionId) {
    req.sessionId = session.id;
  }
  const attachSessionIdentity = (
    result: GatewayChatResult,
  ): GatewayChatResult => ({
    ...result,
    sessionId: req.sessionId,
    sessionKey: session.session_key,
    mainSessionKey: session.main_session_key,
  });
  if (source !== 'fullauto') {
    preemptRunningFullAutoTurn(req.sessionId, source);
    clearScheduledFullAutoContinuation(req.sessionId);
    if (isFullAutoEnabled(session)) {
      noteFullAutoSupervisedIntervention({
        session,
        content: req.content,
        source,
      });
    }
  }
  const activeGatewayRequest = registerActiveGatewayRequest({
    sessionId: req.sessionId,
    executionSessionId: req.executionSessionId,
    abortSignal: req.abortSignal,
  });
  const resolvedRequest = resolveAgentForRequest({
    agentId: req.agentId,
    session,
    model: req.model,
    chatbotId: req.chatbotId,
  });
  const {
    agentId,
    model: resolvedModel,
    chatbotId: resolvedChatbotId,
  } = resolvedRequest;
  const resolvedAgent = resolveAgentConfig(agentId);
  let model = resolvedModel;
  let chatbotId = resolvedChatbotId;
  let chatbotResolution = await resolveGatewayChatbotId({
    model,
    chatbotId,
    sessionId: req.sessionId,
    channelId: req.channelId,
    agentId,
    trigger: 'chat',
  });
  chatbotId = chatbotResolution.chatbotId;
  const channelType =
    resolveChannelType(req) || resolveSessionResetChannelKind(req.channelId);
  const channel =
    (channelType ? getChannel(channelType) : undefined) ||
    getChannelByContextId(req.channelId) ||
    undefined;
  const autoApproveTools = req.autoApproveTools === true;
  const neverAutoApproveTools = Array.isArray(req.neverAutoApproveTools)
    ? req.neverAutoApproveTools
    : FULLAUTO_NEVER_APPROVE_TOOLS;
  if (session.agent_id !== agentId) {
    const reboundExpiryEvaluation = await prepareSessionAutoReset({
      sessionId: req.sessionId,
      channelId: req.channelId,
      agentId,
      chatbotId,
      model,
      enableRag: req.enableRag ?? session.enable_rag === 1,
      policy: sessionResetPolicy,
    });
    const reboundSession = memoryService.resetSessionIfExpired(req.sessionId, {
      policy: sessionResetPolicy,
      expiryEvaluation: reboundExpiryEvaluation,
    });
    if (reboundSession) {
      const previousSessionId = req.sessionId;
      req.sessionId = reboundSession.id;
      if (pluginManager) {
        await pluginManager.handleSessionReset({
          previousSessionId,
          sessionId: req.sessionId,
          userId: req.userId,
          agentId,
          channelId: req.channelId,
          reason: 'auto-reset',
        });
      }
    }
    session = memoryService.getOrCreateSession(
      req.sessionId,
      req.guildId,
      req.channelId,
      agentId,
      { forceNewCurrent: shouldForceNewTuiSession(req) },
    );
    if (session.id !== req.sessionId) {
      req.sessionId = session.id;
    }
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
  let provider = resolveModelProvider(model);
  let media = normalizeMediaContextItems(req.media);
  const workspacePath = path.resolve(
    req.workspacePathOverride || agentWorkspaceDir(agentId),
  );
  const workspaceDisplayPath =
    req.workspaceDisplayRootOverride?.trim() || workspacePath;
  const workspaceBootstrap = req.workspacePathOverride
    ? {
        workspacePath,
        workspaceInitialized: false,
      }
    : ensureBootstrapFiles(agentId);
  if (
    workspaceBootstrap.workspaceInitialized &&
    (session.message_count > 0 || Boolean(session.session_summary))
  ) {
    const rotated = createFreshSessionInstance(req.sessionId);
    req.sessionId = rotated.session.id;
    session = rotated.session;
    if (pluginManager) {
      await pluginManager.handleSessionReset({
        previousSessionId: rotated.previousSession.id,
        sessionId: rotated.session.id,
        userId: req.userId,
        agentId,
        channelId: req.channelId,
        reason: 'workspace-reset',
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
  const audioPrelude = await prependAudioTranscriptionsToUserContent({
    content: req.content,
    media,
    workspaceRoot: workspacePath,
    abortSignal: activeGatewayRequest.signal,
  });
  const userTurnContent = audioPrelude.content;
  const contextReferenceOptions = {
    cwd: workspacePath,
    contextLength: 128_000,
    allowedRoot: workspacePath,
  };
  const contextRefResult = await preprocessContextReferences({
    message: userTurnContent,
    ...contextReferenceOptions,
  });
  let effectiveUserTurnContent = userTurnContent;
  let effectiveUserTurnContentExpanded = contextRefResult.message;
  let effectiveUserTurnContentStripped = contextRefResult.strippedMessage;
  const canonicalContextScope = resolveCanonicalContextScope(session);
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
  if (turnIndex === 1) {
    if (pluginManager) {
      await pluginManager.notifySessionStart({
        sessionId: req.sessionId,
        userId: req.userId,
        agentId,
        channelId: req.channelId,
        workspacePath,
      });
    }
  }
  const isInteractiveSource =
    source !== 'fullauto' &&
    channelType !== 'scheduler' &&
    channelType !== 'heartbeat';
  const explicitModelPinned = Boolean(
    req.model?.trim() ||
      session.model?.trim() ||
      resolveAgentModel(resolvedAgent),
  );
  const conciergeTurn = await resolveConciergeTurn({
    sessionId: req.sessionId,
    requestContent: req.content,
    agentId,
    chatbotId,
    currentModel: model,
    isInteractiveSource,
    explicitModelPinned,
    media,
    effectiveUserTurnContent,
    effectiveUserTurnContentExpanded,
    effectiveUserTurnContentStripped,
    normalizeMediaContextItems,
    cloneMediaContextItems,
  });
  let conciergeExecutionProfile: ConciergeProfile | null = null;
  if (conciergeTurn.kind === 'respond') {
    const storedTurn = recordSuccessfulTurn({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
      promptMode: req.promptMode,
      runId,
      turnIndex,
      userId: req.userId,
      username: req.username,
      canonicalScopeId: canonicalContextScope,
      userContent: buildStoredUserTurnContent(userTurnContent, media),
      resultText: conciergeTurn.resultText,
      toolCallCount: 0,
      startedAt,
      replaceBuiltInMemory: pluginMemoryBehavior.replacesBuiltInMemory,
    });
    return attachSessionIdentity({
      status: 'success',
      result: conciergeTurn.resultText,
      agentId,
      model,
      provider,
      components:
        source === 'discord'
          ? buildConciergeChoiceComponents({
              sessionId: req.sessionId,
              userId: req.userId,
            })
          : undefined,
      toolsUsed: [],
      userMessageId: storedTurn.userMessageId,
      assistantMessageId: storedTurn.assistantMessageId,
    });
  }
  conciergeExecutionProfile = conciergeTurn.conciergeExecutionProfile;
  model = conciergeTurn.model;
  provider = conciergeTurn.provider;
  media = conciergeTurn.media;
  effectiveUserTurnContent = conciergeTurn.effectiveUserTurnContent;
  effectiveUserTurnContentExpanded =
    conciergeTurn.effectiveUserTurnContentExpanded;
  effectiveUserTurnContentStripped =
    conciergeTurn.effectiveUserTurnContentStripped;
  if (model !== resolvedModel) {
    chatbotResolution = await resolveGatewayChatbotId({
      model,
      chatbotId,
      sessionId: req.sessionId,
      channelId: req.channelId,
      agentId,
      trigger: 'chat',
    });
    chatbotId = chatbotResolution.chatbotId;
  }
  const debugMeta = {
    sessionId: req.sessionId,
    guildId: req.guildId,
    channelId: req.channelId,
    userId: req.userId,
    model,
    provider,
    turnIndex,
    mediaCount: media.length,
    audioTranscriptCount: audioPrelude.transcripts.length,
    contentLength: effectiveUserTurnContentExpanded.length,
    streamingRequested: Boolean(
      req.onTextDelta || req.onToolProgress || req.onApprovalProgress,
    ),
  };

  logger.debug(debugMeta, 'Gateway chat request received');

  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'session.start',
      userId: req.userId,
      channel: req.channelId,
      cwd: workspacePath,
      model,
      source,
    },
  });
  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'turn.start',
      turnIndex,
      userInput: userTurnContent,
      ...(userTurnContent !== req.content ? { rawUserInput: req.content } : {}),
      username: req.username,
      mediaCount: media.length,
      source,
    },
  });

  if (modelRequiresChatbotId(model) && !chatbotId) {
    const error =
      chatbotResolution.error ||
      'No chatbot configured. Set `hybridai.defaultChatbotId` in ~/.hybridclaw/config.json or select a bot for this session.';
    logger.warn(
      {
        ...debugMeta,
        sessionModel: session.model ?? null,
        sessionChatbotId: session.chatbot_id ?? null,
        requestChatbotId: req.chatbotId ?? null,
        defaultModel: HYBRIDAI_MODEL,
        defaultChatbotConfigured: Boolean(HYBRIDAI_CHATBOT_ID),
        fallbackSource: chatbotResolution.source,
        durationMs: Date.now() - startedAt,
      },
      'Gateway chat blocked by missing chatbot configuration',
    );
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'configuration',
        message: error,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      agentId,
      model,
      provider,
      error,
    };
  }

  if (isVersionOnlyQuestion(req.content)) {
    const resultText = `HybridClaw v${APP_VERSION}`;
    const storedTurn = recordSuccessfulTurn({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
      promptMode: req.promptMode,
      runId,
      turnIndex,
      userId: req.userId,
      username: req.username,
      canonicalScopeId: canonicalContextScope,
      userContent: req.content,
      resultText,
      toolCallCount: 0,
      startedAt,
      replaceBuiltInMemory: pluginMemoryBehavior.replacesBuiltInMemory,
    });
    const result: GatewayChatResult = {
      status: 'success',
      result: resultText,
      toolsUsed: [],
      agentId,
      model,
      provider,
      userMessageId: storedTurn.userMessageId,
      assistantMessageId: storedTurn.assistantMessageId,
    };
    maybeScheduleFullAutoAfterSuccess({ session, req, result });
    return attachSessionIdentity(result);
  }

  const history = memoryService
    .getConversationHistory(req.sessionId, MAX_HISTORY_MESSAGES * 2)
    .filter((message) => !isSilentReply(message.content))
    .slice(0, MAX_HISTORY_MESSAGES);
  let pluginsUsed: string[] = [];
  let canonicalContext: CanonicalSessionContext = {
    summary: null,
    recent_messages: [],
  };
  if (canonicalContextScope && !pluginMemoryBehavior.replacesBuiltInMemory) {
    try {
      canonicalContext = memoryService.getCanonicalContext({
        agentId,
        userId: canonicalContextScope,
        windowSize: 12,
        excludeSessionId: req.sessionId,
      });
      canonicalContext = {
        ...canonicalContext,
        recent_messages: canonicalContext.recent_messages.filter(
          (message) => !isSilentReply(message.content),
        ),
      };
    } catch (err) {
      logger.debug(
        { sessionId: req.sessionId, canonicalContextScope, err },
        'Failed to load canonical session context',
      );
    }
  }
  const canonicalPromptSummary = pluginMemoryBehavior.replacesBuiltInMemory
    ? ''
    : formatCanonicalContextPrompt({
        summary: canonicalContext.summary,
        recentMessages: canonicalContext.recent_messages,
      });
  const pluginRecentMessages = [...history].reverse();
  pluginRecentMessages.push({
    id: 0,
    session_id: req.sessionId,
    user_id: req.userId,
    username: req.username || null,
    role: 'user',
    content: contextRefResult.originalMessage,
    created_at: new Date(startedAt).toISOString(),
  });
  const pluginPromptDetails = pluginManager
    ? await pluginManager.collectPromptContextDetails({
        sessionId: req.sessionId,
        userId: req.userId,
        agentId,
        channelId: req.channelId,
        workspacePath,
        recentMessages: pluginRecentMessages,
      })
    : { sections: [], pluginIds: [] };
  pluginsUsed = pluginPromptDetails.pluginIds;
  const pluginPromptSummary = formatPluginPromptContext(
    pluginPromptDetails.sections,
  );
  const memoryContext: BuildMemoryPromptResult =
    pluginMemoryBehavior.replacesBuiltInMemory
      ? {
          promptSummary: null,
          summaryConfidence: null,
          semanticMemories: [],
          citationIndex: [],
        }
      : memoryService.buildPromptMemoryContext({
          session,
          query: effectiveUserTurnContentStripped,
        });
  const mergedSessionSummary = pluginMemoryBehavior.replacesBuiltInMemory
    ? pluginPromptSummary || null
    : [canonicalPromptSummary, memoryContext.promptSummary]
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .join('\n\n')
        .trim() || null;
  const fullAutoOperatingContract = isFullAutoEnabled(session)
    ? buildFullAutoOperatingContract(
        session,
        source === 'fullauto' ? 'background' : 'supervised',
      )
    : undefined;
  const mediaPolicy = resolveMediaToolPolicy(effectiveUserTurnContent, media);
  const { messages, skills, historyStats, explicitSkillInvocation } =
    buildConversationContext({
      agentId,
      sessionSummary: mergedSessionSummary,
      retrievedContext: pluginMemoryBehavior.replacesBuiltInMemory
        ? null
        : pluginPromptSummary,
      history,
      currentUserContent: effectiveUserTurnContent,
      promptMode: req.promptMode,
      includePromptParts: req.includePromptParts,
      omitPromptParts: req.omitPromptParts,
      extraSafetyText: fullAutoOperatingContract,
      runtimeInfo: {
        chatbotId,
        model,
        defaultModel: HYBRIDAI_MODEL,
        channel,
        channelType,
        channelId: req.channelId,
        guildId: req.guildId,
        sessionContext,
        workspacePath: workspaceDisplayPath,
      },
      blockedTools: mediaPolicy.blockedTools,
    });
  const historyStart =
    messages.length > 0 && messages[0].role === 'system' ? 1 : 0;
  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
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
        messages.slice(historyStart),
      ),
      canonicalSummaryIncluded:
        !pluginMemoryBehavior.replacesBuiltInMemory &&
        Boolean(canonicalPromptSummary),
      canonicalRecentMessagesIncluded:
        pluginMemoryBehavior.replacesBuiltInMemory
          ? 0
          : canonicalContext.recent_messages.length,
      pluginMemoryReplacement: pluginMemoryBehavior.replacesBuiltInMemory,
      pluginContextSectionsIncluded: pluginPromptDetails.sections.length,
    },
  });
  if (mediaPolicy.prioritizeVisionTool) {
    logger.info(
      {
        sessionId: req.sessionId,
        mediaCount: media.length,
        blockedTools: mediaPolicy.blockedTools || [],
      },
      'Routing Discord image question to vision_analyze tool',
    );
  }
  const mediaContextBlock = buildMediaPromptContext(media);
  const skillArgsContext = explicitSkillInvocation
    ? await preprocessContextReferences({
        message: explicitSkillInvocation.args,
        ...contextReferenceOptions,
      })
    : null;
  const expandedUserContent = explicitSkillInvocation
    ? expandResolvedSkillInvocation(
        explicitSkillInvocation,
        skillArgsContext?.message ?? '',
      )
    : effectiveUserTurnContentExpanded;
  const explicitSkillName = explicitSkillInvocation?.skill.name || null;
  const agentUserContent = mediaContextBlock
    ? `${expandedUserContent}\n\n${mediaContextBlock}`
    : expandedUserContent;
  logger.debug(
    {
      ...debugMeta,
      durationMs: Date.now() - startedAt,
      historyMessages: history.length,
      promptMessages: messages.length + 1,
      skillsLoaded: skills.length,
      blockedTools: mediaPolicy.blockedTools || [],
      scheduledTaskHistoryCount: historyStats.includedCount,
    },
    'Gateway chat context prepared',
  );
  messages.push({
    role: 'user',
    content: agentUserContent,
  });
  const requestMessages = isGatewayRequestLoggingEnabled()
    ? messages.slice()
    : null;

  let agentStage:
    | 'pre-agent'
    | 'awaiting-agent-output'
    | 'processing-agent-output' = 'pre-agent';

  try {
    const scheduledTasks = getTasksForSession(req.sessionId);
    let firstTextDeltaMs: number | null = null;
    const onTextDelta = (delta: string): void => {
      if (firstTextDeltaMs == null && delta) {
        firstTextDeltaMs = Date.now() - startedAt;
        logger.debug(
          {
            ...debugMeta,
            firstTextDeltaMs,
            firstDeltaChars: delta.length,
          },
          'Gateway chat emitted first text delta',
        );
      }
      req.onTextDelta?.(delta);
    };
    const emitTextDeltas = req.onTextDelta ? onTextDelta : undefined;
    const onToolProgress = (event: ToolProgressEvent): void => {
      logger.debug(
        {
          ...debugMeta,
          toolName: event.toolName,
          phase: event.phase,
          toolDurationMs: event.durationMs ?? null,
          sinceStartMs: Date.now() - startedAt,
        },
        'Gateway tool progress',
      );
      if (!shouldEmitTools) return;
      req.onToolProgress?.(event);
    };
    const onApprovalProgress = (approval: PendingApproval): void => {
      logger.debug(
        {
          ...debugMeta,
          approvalId: approval.approvalId,
          approvalIntent: approval.intent,
          approvalReason: approval.reason,
          sinceStartMs: Date.now() - startedAt,
        },
        'Gateway approval progress',
      );
      req.onApprovalProgress?.(approval);
    };
    logger.debug(
      {
        ...debugMeta,
        scheduledTaskCount: scheduledTasks.length,
      },
      'Gateway chat invoking agent',
    );
    const conciergeExecutionNotice = conciergeExecutionProfile
      ? buildConciergeExecutionNotice(conciergeExecutionProfile, model)
      : null;
    if (conciergeExecutionNotice) {
      req.onTextDelta?.(conciergeExecutionNotice);
    }
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'agent.start',
        provider,
        model,
        scheduledTaskCount: scheduledTasks.length,
        promptMessages: messages.length,
        systemPrompt: readSystemPromptMessage(messages),
      },
    });
    if (pluginManager) {
      await pluginManager.notifyBeforeAgentStart({
        sessionId: req.sessionId,
        userId: req.userId,
        agentId,
        channelId: req.channelId,
        model: model || undefined,
      });
    }
    agentStage = 'awaiting-agent-output';
    const output = await runAgent({
      sessionId: req.executionSessionId || req.sessionId,
      messages,
      chatbotId,
      enableRag,
      executorModeOverride: req.executorModeOverride,
      model,
      agentId,
      workspacePathOverride: req.workspacePathOverride,
      workspaceDisplayRootOverride: req.workspaceDisplayRootOverride,
      skipContainerSystemPrompt: req.promptMode === 'none',
      maxTokens: req.maxTokens,
      maxWallClockMs: req.maxWallClockMs,
      inactivityTimeoutMs: req.inactivityTimeoutMs,
      bashProxy: req.bashProxy,
      channelId: req.channelId,
      ralphMaxIterations: resolveSessionRalphIterations(session),
      fullAutoEnabled: autoApproveTools || isFullAutoEnabled(session),
      fullAutoNeverApproveTools: neverAutoApproveTools,
      scheduledTasks,
      blockedTools: mediaPolicy.blockedTools,
      onTextDelta: emitTextDeltas,
      onToolProgress,
      onApprovalProgress,
      abortSignal: activeGatewayRequest.signal,
      media,
      audioTranscriptsPrepended: audioPrelude.transcripts.length > 0,
      pluginTools: pluginManager?.getToolDefinitions() ?? [],
    });
    agentStage = 'processing-agent-output';
    const storedUserContent = buildStoredUserTurnContent(
      userTurnContent,
      media,
    );
    const toolExecutions = output.toolExecutions || [];
    const observedSkillName = resolveObservedSkillName({
      explicitSkillName,
      toolExecutions,
      skills,
    });
    emitToolExecutionAuditEvents({
      sessionId: req.sessionId,
      runId,
      toolExecutions,
    });
    const usagePayload = buildTokenUsageAuditPayload(
      messages,
      output.result,
      output.tokenUsage,
    );
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'model.usage',
        provider,
        model,
        durationMs: Date.now() - startedAt,
        toolCallCount: toolExecutions.length,
        ...usagePayload,
      },
    });
    recordUsageEvent({
      sessionId: req.sessionId,
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
          sessionId: req.sessionId,
          runId,
          toolExecutions,
          outcome: deriveSkillExecutionOutcome({
            outputStatus: output.status,
            toolExecutions,
          }),
          durationMs: Date.now() - startedAt,
          errorDetail: output.error,
        });
      } catch (error) {
        logger.warn(
          { sessionId: req.sessionId, skillName: observedSkillName, error },
          'Failed to record skill execution observation',
        );
      }
    }

    const parentDepth = extractDelegationDepth(req.sessionId);
    let acceptedDelegations = 0;
    processSideEffects(output, req.sessionId, req.channelId, {
      onDelegation: (effect) => {
        const normalized = normalizeDelegationEffect(effect, model);
        if (!normalized.plan) {
          logger.warn(
            {
              sessionId: req.sessionId,
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
              sessionId: req.sessionId,
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
              sessionId: req.sessionId,
              limit: PROACTIVE_DELEGATION_MAX_PER_TURN,
              requestedRuns,
              acceptedDelegations,
            },
            'Delegation skipped — per-turn limit reached',
          );
          return;
        }
        acceptedDelegations += requestedRuns;
        enqueueDelegationFromSideEffect({
          plan: normalized.plan,
          parentSessionId: req.sessionId,
          channelId: req.channelId,
          chatbotId,
          enableRag,
          agentId,
          onProactiveMessage: req.onProactiveMessage,
          parentDepth,
        });
      },
    });

    if (output.status === 'error') {
      const errorMessage = output.error || 'Unknown agent error.';
      const durationMs = Date.now() - startedAt;
      logger.debug(
        {
          ...debugMeta,
          durationMs,
          toolCallCount: toolExecutions.length,
          firstTextDeltaMs,
          artifactCount: output.artifacts?.length || 0,
        },
        'Gateway chat completed with agent error',
      );
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'error',
          errorType: 'agent',
          message: errorMessage,
          recoverable: true,
          stage: agentStage,
        },
      });
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
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
      if (requestMessages !== null) {
        maybeRecordGatewayRequestLog({
          sessionId: req.sessionId,
          model,
          chatbotId,
          messages: requestMessages,
          status: 'error',
          error: errorMessage,
          toolExecutions,
          toolsUsed: output.toolsUsed || [],
          durationMs,
        });
      }
      return attachSessionIdentity({
        status: 'error',
        result: null,
        toolsUsed: output.toolsUsed || [],
        pluginsUsed,
        agentId,
        model,
        provider,
        artifacts: output.artifacts,
        toolExecutions,
        tokenUsage: output.tokenUsage,
        error: errorMessage,
      });
    }

    const rawResultText = output.result || 'No response from agent.';
    const resultText = conciergeExecutionNotice
      ? `${conciergeExecutionNotice}${rawResultText}`
      : rawResultText;
    const memoryCitations = extractMemoryCitations(
      resultText,
      memoryContext.citationIndex,
    );
    if (memoryCitations.length > 0) {
      output.memoryCitations = memoryCitations;
    }
    const durationMs = Date.now() - startedAt;
    logger.debug(
      {
        ...debugMeta,
        durationMs,
        toolCallCount: toolExecutions.length,
        firstTextDeltaMs,
        artifactCount: output.artifacts?.length || 0,
      },
      'Gateway chat completed successfully',
    );
    const storedTurn = recordSuccessfulTurn({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
      promptMode: req.promptMode,
      runId,
      turnIndex,
      userId: req.userId,
      username: req.username,
      canonicalScopeId: canonicalContextScope,
      userContent: storedUserContent,
      resultText,
      toolCallCount: toolExecutions.length,
      startedAt,
      replaceBuiltInMemory: pluginMemoryBehavior.replacesBuiltInMemory,
    });
    const storedTurnMessages = buildStoredTurnMessages({
      sessionId: req.sessionId,
      userId: req.userId,
      username: req.username,
      userContent: storedUserContent,
      resultText,
    });
    if (pluginManager) {
      await pluginManager.notifyMemoryWrites({
        sessionId: req.sessionId,
        agentId,
        channelId: req.channelId,
        toolExecutions,
      });
      void pluginManager
        .notifyTurnComplete({
          sessionId: req.sessionId,
          userId: req.userId,
          agentId,
          workspacePath,
          messages: storedTurnMessages,
        })
        .catch((error) => {
          logger.warn(
            { sessionId: req.sessionId, agentId, error },
            'Plugin turn-complete hooks failed',
          );
        });
      void pluginManager
        .notifyAgentEnd({
          sessionId: req.sessionId,
          userId: req.userId,
          agentId,
          channelId: req.channelId,
          messages: storedTurnMessages,
          resultText,
          toolNames: toolExecutions.map((execution) => execution.name),
          model: model || undefined,
          durationMs: Date.now() - startedAt,
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
            { sessionId: req.sessionId, agentId, error },
            'Plugin agent-end hooks failed',
          );
        });
    }

    const result: GatewayChatResult = {
      status: 'success',
      result: resultText,
      toolsUsed: output.toolsUsed || [],
      pluginsUsed,
      agentId,
      model,
      provider,
      memoryCitations: output.memoryCitations,
      artifacts: output.artifacts,
      toolExecutions,
      pendingApproval: output.pendingApproval,
      tokenUsage: output.tokenUsage,
      effectiveUserPrompt: output.effectiveUserPrompt,
      userMessageId: storedTurn.userMessageId,
      assistantMessageId: storedTurn.assistantMessageId,
    };
    maybeScheduleFullAutoAfterSuccess({ session, req, result });
    if (requestMessages !== null) {
      maybeRecordGatewayRequestLog({
        sessionId: req.sessionId,
        model,
        chatbotId,
        messages: requestMessages,
        status: 'success',
        response: resultText,
        toolExecutions,
        toolsUsed: output.toolsUsed || [],
        durationMs,
      });
    }
    return attachSessionIdentity(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    logAudit('error', req.sessionId, { error: errorMsg }, durationMs);
    logger.error(
      {
        ...debugMeta,
        durationMs,
        stage: agentStage,
        err,
      },
      'Gateway message handling failed',
    );
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'gateway',
        message: errorMsg,
        recoverable: true,
        stage: agentStage,
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs,
        },
      },
    });
    if (requestMessages !== null) {
      maybeRecordGatewayRequestLog({
        sessionId: req.sessionId,
        model,
        chatbotId,
        messages: requestMessages,
        status: 'error',
        error: errorMsg,
        durationMs,
      });
    }
    return attachSessionIdentity({
      status: 'error',
      result: null,
      toolsUsed: [],
      pluginsUsed,
      agentId,
      model,
      provider,
      toolExecutions: undefined,
      error: errorMsg,
    });
  } finally {
    activeGatewayRequest.release();
  }
}
