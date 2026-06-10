import path from 'node:path';
import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import type { MiddlewareEvent } from '../agent/middleware.js';
import { emitPostTurnEvent } from '../agent/post-turn-events.js';
import type { PromptMode } from '../agent/prompt-hooks.js';
import {
  type PromptPartName,
  parsePromptPartList,
} from '../agent/prompt-parts.js';
import { processSideEffects } from '../agent/side-effects.js';
import { isSilentReply } from '../agent/silent-reply.js';
import {
  resolveAgentConfig,
  resolveAgentEscalationTarget,
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
import {
  clearScheduledGoalContinuation,
  isGoalContinuationSource,
  pauseActiveGoalForSession,
} from '../goals/goal-runtime.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { prependAudioTranscriptionsToUserContent } from '../media/audio-transcription.js';
import { extractMemoryCitations } from '../memory/citation-extractor.js';
import {
  createFreshSessionInstance,
  logAudit,
  storeSemanticMemory,
} from '../memory/db.js';
import { getAllJobs } from '../memory/jobs.js';
import {
  type BuildMemoryPromptResult,
  memoryService,
} from '../memory/memory-service.js';
import { withSpan } from '../observability/otel.js';
import { captureSentryException } from '../observability/sentry.js';
import { loadPolicyFullAutoNeverApprove } from '../policy/remote-policy-authority.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import { resolveSessionResetChannelKind } from '../session/session-reset.js';
import { maybeAutoTitleSession } from '../session/session-title.js';
import { estimateTokenCountFromMessages } from '../session/token-efficiency.js';
import {
  expandResolvedSkillInvocation,
  promoteWorkspaceSkills,
  resolveObservedSkillName,
} from '../skills/skills.js';
import {
  deriveSkillExecutionOutcome,
  recordSkillExecution,
} from '../skills/skills-observation.js';
import type { ContainerOutput, MediaContextItem } from '../types/container.js';
import {
  type ArtifactMetadata,
  normalizeEscalationTarget,
  type PendingApproval,
  type ToolProgressEvent,
} from '../types/execution.js';
import type { CanonicalSessionContext } from '../types/session.js';
import { buildMediaGenerationUsageEvents } from '../usage/media-generation-usage.js';
import { resolveUsageCostUsdAfterMetadataRefresh } from '../usage/model-cost.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';
import { parseJsonObject } from '../utils/json-object.js';
import {
  ensureBootstrapFiles,
  resolveStartupBootstrapFile,
} from '../workspace.js';
import {
  getActiveThreadAgentId,
  resolveAgentAddressing,
  setActiveThreadAgentId,
} from './agent-addressing.js';
import { normalizeSilentMessageSendReply } from './chat-result.js';
import { emitDiagramRuntimeEventsForToolExecutions } from './diagram-runtime-events.js';
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
import {
  GATEWAY_SYSTEM_PROMPT_MODE_ENV,
  GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
  GATEWAY_TOOLS_MODE_ENV,
} from './gateway-lifecycle.js';
import { tryEnsurePluginManagerInitializedForGateway } from './gateway-plugin-runtime.js';
import { registerActiveGatewayRequest } from './gateway-request-runtime.js';
import {
  buildMediaPromptContext,
  buildStoredTurnMessages,
  buildStoredUserTurnContent,
  buildTokenUsageAuditPayload,
  enqueueDelegationBatchFromSideEffects,
  extractDelegationDepth,
  formatCanonicalContextPrompt,
  formatPluginPromptContext,
  getGatewayAssistantPresentationForMessageAgent,
  isGatewayRequestLoggingEnabled,
  isVersionOnlyQuestion,
  maybeRecordGatewayRequestLog,
  normalizeDelegationEffect,
  normalizeMediaContextItems,
  prepareSessionAutoReset,
  readDynamicContextMessage,
  readSystemPromptMessage,
  recordSuccessfulTurn,
  resolveCanonicalContextScope,
  resolveChannelType,
  resolveGatewayChatbotId,
  resolveMediaToolPolicy,
  resolveSessionAutoResetPolicy,
  shouldForceNewTuiSession,
} from './gateway-service.js';
import type {
  GatewayChatRequest,
  GatewayChatResult,
  GatewayMessageComponents,
} from './gateway-types.js';
import {
  extensionToMimeType,
  firstNumber,
  resolveWorkspaceRelativePath,
} from './gateway-utils.js';
import { isSupportedProactiveChannelId } from './proactive-delivery.js';
import { forwardGatewayMessageToProxyAgent } from './proxy-agent.js';
import {
  detectCliSecretSetCommand,
  renderCliSecretSetCommandWarning,
} from './secret-command-guard.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from './show-mode.js';

const MAX_HISTORY_MESSAGES = 40;

function resolveTurnRuntimeAuditLabel(
  model: string,
  output: Pick<ContainerOutput, 'codexRuntime'> | undefined,
): 'codex' | 'hybridclaw' {
  return resolveModelProvider(model) === 'openai-codex' &&
    output?.codexRuntime === 'app-server'
    ? 'codex'
    : 'hybridclaw';
}

function persistSpeechTranscriptsToScopedMemory(params: {
  sessionId: string;
  skillName: string | null;
  toolExecutions: Array<{ name: string; result: string; isError?: boolean }>;
}): void {
  const scope = params.skillName?.startsWith('speech.')
    ? `skill:${params.skillName}`
    : 'skill:speech-to-text';
  for (const execution of params.toolExecutions) {
    if (execution.name !== 'audio_transcribe' || execution.isError) continue;
    const payload = parseJsonObject(execution.result);
    if (!payload || payload.success !== true) continue;
    if (typeof payload.action === 'string' && payload.action !== 'transcribe') {
      continue;
    }
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) continue;
    storeSemanticMemory({
      sessionId: params.sessionId,
      role: 'assistant',
      source: 'audio_transcribe',
      scope,
      content: text,
      confidence: 0.95,
      metadata: {
        provider: payload.provider,
        model: payload.model,
        language: payload.language,
        duration_sec: payload.duration_sec,
        cost_usd: payload.cost_usd,
        segments: payload.segments,
        artifacts: payload.artifacts,
      },
    });
  }
}

function formatEscalationRouteNotice(
  approval: PendingApproval,
  target: NonNullable<PendingApproval['escalationTarget']>,
): string {
  return `Escalation for ${target.recipient} on ${target.channel}.\n\n${approval.prompt}`;
}

async function routeEscalationApproval(params: {
  approval: PendingApproval | undefined;
  agentId: string;
  currentChannelId: string;
  sessionId: string;
  runId: string;
  onProactiveMessage: GatewayChatRequest['onProactiveMessage'];
}): Promise<void> {
  if (!params.approval) return;
  const target = normalizeEscalationTarget(params.approval.escalationTarget);
  if (!target) return;
  const targetChannel = target.channel;
  if (targetChannel === params.currentChannelId) return;
  const auditBase = {
    type: 'escalation.route',
    approvalId: params.approval.approvalId,
    agentId: params.agentId,
    currentChannelId: params.currentChannelId,
    targetChannel,
    targetRecipient: target.recipient,
  };
  if (!isSupportedProactiveChannelId(targetChannel)) {
    logger.warn(
      {
        approvalId: params.approval.approvalId,
        sourceAgentId: params.agentId,
        targetChannel,
      },
      'Blocked escalation approval route to unsupported proactive target',
    );
    recordAuditEvent({
      sessionId: params.sessionId,
      runId: params.runId,
      event: {
        ...auditBase,
        result: 'blocked',
        reason: 'unsupported_proactive_target',
      },
    });
    return;
  }
  if (!params.onProactiveMessage) {
    logger.warn(
      {
        approvalId: params.approval.approvalId,
        sourceAgentId: params.agentId,
        targetChannel,
      },
      'Unable to route escalation approval notification because onProactiveMessage is unavailable',
    );
    recordAuditEvent({
      sessionId: params.sessionId,
      runId: params.runId,
      event: {
        ...auditBase,
        result: 'not_sent',
        reason: 'missing_proactive_callback',
      },
    });
    return;
  }
  try {
    await params.onProactiveMessage({
      channelId: targetChannel,
      text: formatEscalationRouteNotice(params.approval, target),
    });
    logger.info(
      {
        approvalId: params.approval.approvalId,
        sourceAgentId: params.agentId,
        targetChannel,
      },
      'Routed escalation approval notification',
    );
    recordAuditEvent({
      sessionId: params.sessionId,
      runId: params.runId,
      event: {
        ...auditBase,
        result: 'sent',
      },
    });
  } catch (error) {
    logger.warn(
      {
        approvalId: params.approval.approvalId,
        sourceAgentId: params.agentId,
        targetChannel,
        error,
      },
      'Failed to route escalation approval notification',
    );
    recordAuditEvent({
      sessionId: params.sessionId,
      runId: params.runId,
      event: {
        ...auditBase,
        result: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function readGatewayPromptModeDefault(): PromptMode | undefined {
  const raw = String(process.env[GATEWAY_SYSTEM_PROMPT_MODE_ENV] || '')
    .trim()
    .toLowerCase();
  if (!raw) return undefined;
  if (raw === 'full' || raw === 'minimal' || raw === 'none') return raw;
  throw new Error(
    `Invalid value for ${GATEWAY_SYSTEM_PROMPT_MODE_ENV}: ${raw}. Use full, minimal, or none.`,
  );
}

function readGatewayToolsDisabledDefault(): boolean {
  const raw = String(process.env[GATEWAY_TOOLS_MODE_ENV] || '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'full') return false;
  if (raw === 'none') return true;
  throw new Error(
    `Invalid value for ${GATEWAY_TOOLS_MODE_ENV}: ${raw}. Use full or none.`,
  );
}

function readGatewayPromptPartDefault(
  envName: string,
  flagName: string,
): PromptPartName[] | undefined {
  const raw = String(process.env[envName] || '').trim();
  if (!raw) return undefined;
  try {
    return parsePromptPartList(raw, flagName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid value for ${envName}: ${message}`);
  }
}

export function validateGatewayPromptEnvDefaults(): void {
  readGatewayPromptModeDefault();
  readGatewayToolsDisabledDefault();
  readGatewayPromptPartDefault(
    GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
    '--system-prompt',
  );
}

export function buildEmptyAgentResponseFallback(
  artifacts?: ArtifactMetadata[],
): string {
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  if (artifactList.length === 0) return 'No response from agent.';
  return '';
}

const GENERATED_MEDIA_ARTIFACT_RE =
  /(?:\/workspace\/|\.\/)?(\.generated-(?:images|videos)\/[A-Za-z0-9._@%+=-]+\.(?:png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm))/gi;

function isGeneratedMediaPath(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return (
    parts.includes('.generated-images') || parts.includes('.generated-videos')
  );
}

function normalizeArtifactTextPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function decodeArtifactTextVariants(resultText: string): string[] {
  const variants = [resultText];
  try {
    // Web chat artifact URLs encode path separators; recover those when the
    // model copies an `/api/artifact?path=...` URL into final text.
    const decoded = decodeURIComponent(resultText);
    if (decoded !== resultText) variants.push(decoded);
  } catch {
    // Leave malformed percent escapes untouched.
  }
  return variants;
}

function extractGeneratedMediaReferences(params: {
  resultText: string;
  workspacePath: string;
}): Array<{ filePath: string; filename: string }> {
  const references: Array<{
    filePath: string;
    filename: string;
  }> = [];
  const seen = new Set<string>();
  for (const textVariant of decodeArtifactTextVariants(params.resultText)) {
    for (const match of textVariant.matchAll(GENERATED_MEDIA_ARTIFACT_RE)) {
      const relativePath = match[1];
      if (!relativePath) continue;
      const filePath = resolveWorkspaceRelativePath(
        params.workspacePath,
        relativePath,
      );
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      references.push({
        filePath,
        filename: path.basename(filePath),
      });
    }
  }
  return references;
}

function artifactIsMentionedInText(params: {
  artifact: ArtifactMetadata;
  resultTextVariants: string[];
  workspacePath: string;
}): boolean {
  const mentionedValues = new Set<string>();
  const filename = params.artifact.filename.trim();
  if (filename) mentionedValues.add(filename);

  const artifactPath = normalizeArtifactTextPath(params.artifact.path);
  if (artifactPath) mentionedValues.add(artifactPath);

  const relativePath = normalizeArtifactTextPath(
    path.relative(params.workspacePath, params.artifact.path),
  );
  if (
    relativePath &&
    relativePath !== '..' &&
    !relativePath.startsWith('../')
  ) {
    mentionedValues.add(relativePath);
    mentionedValues.add(`./${relativePath}`);
    mentionedValues.add(`/workspace/${relativePath}`);
  }

  for (const textVariant of params.resultTextVariants) {
    const normalizedText = normalizeArtifactTextPath(textVariant);
    for (const value of mentionedValues) {
      if (value && normalizedText.includes(value)) return true;
    }
  }
  return false;
}

export function recoverGeneratedMediaArtifactsFromResultText(params: {
  resultText: string;
  workspacePath: string;
  artifacts?: ArtifactMetadata[];
}): ArtifactMetadata[] | undefined {
  const existing = Array.isArray(params.artifacts) ? params.artifacts : [];
  const recovered = [...existing];
  const seen = new Set(existing.map((artifact) => artifact.path));
  const references = extractGeneratedMediaReferences({
    resultText: params.resultText,
    workspacePath: params.workspacePath,
  });
  for (const reference of references) {
    if (seen.has(reference.filePath)) continue;
    seen.add(reference.filePath);
    recovered.push({
      path: reference.filePath,
      filename: reference.filename,
      mimeType: extensionToMimeType(
        path.extname(reference.filename),
        'image/png',
      ),
    });
  }
  if (recovered.length > 1) {
    const resultTextVariants = decodeArtifactTextVariants(params.resultText);
    const mentionedGeneratedArtifacts = new Set(
      recovered
        .filter(
          (artifact) =>
            isGeneratedMediaPath(artifact.path) &&
            artifactIsMentionedInText({
              artifact,
              resultTextVariants,
              workspacePath: params.workspacePath,
            }),
        )
        .map((artifact) => path.resolve(artifact.path)),
    );
    if (mentionedGeneratedArtifacts.size === 0) {
      return recovered;
    }
    return recovered.filter((artifact) => {
      if (!isGeneratedMediaPath(artifact.path)) return true;
      return mentionedGeneratedArtifacts.has(path.resolve(artifact.path));
    });
  }
  return recovered.length > 0 ? recovered : undefined;
}

function resolveGatewayPromptPartDefaults(req: GatewayChatRequest): {
  promptMode?: PromptMode;
  includePromptParts?: PromptPartName[];
  omitPromptParts?: PromptPartName[];
  toolsDisabled: boolean;
} {
  const promptMode = req.promptMode ?? readGatewayPromptModeDefault();
  const toolsDisabled = readGatewayToolsDisabledDefault();
  const includePromptParts =
    req.includePromptParts ??
    readGatewayPromptPartDefault(
      GATEWAY_SYSTEM_PROMPT_PARTS_ENV,
      '--system-prompt',
    );
  return {
    ...(promptMode ? { promptMode } : {}),
    ...(includePromptParts && includePromptParts.length > 0
      ? { includePromptParts }
      : {}),
    ...(req.omitPromptParts && req.omitPromptParts.length > 0
      ? { omitPromptParts: req.omitPromptParts }
      : {}),
    toolsDisabled,
  };
}

interface ConciergeRouterMetadata {
  profile?: string;
  model?: string;
  notice?: string | null;
  effectiveUserTurnContent?: string;
  effectiveUserTurnContentExpanded?: string;
  effectiveUserTurnContentStripped?: string;
  media?: MediaContextItem[];
  components?: GatewayMessageComponents;
}

function getConciergeRouterMetadata(
  event: MiddlewareEvent | undefined,
): ConciergeRouterMetadata | null {
  const raw = event?.metadata?.conciergeRouter;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as ConciergeRouterMetadata;
}

function resolvePluginRoutingModel(params: {
  configuredModel?: string;
  currentModel: string;
  chatbotId: string;
  profile?: string;
}): string {
  const configuredModel = String(params.configuredModel || '').trim();
  if (!configuredModel) return params.currentModel;
  if (!modelRequiresChatbotId(configuredModel) || params.chatbotId) {
    return configuredModel;
  }
  if (!modelRequiresChatbotId(params.currentModel)) {
    logger.info(
      {
        currentModel: params.currentModel,
        configuredModel,
        profile: params.profile,
      },
      'Routing middleware kept the current model because the configured model requires a chatbot',
    );
    return params.currentModel;
  }
  return configuredModel;
}

function captureGatewayChatResultError(params: {
  message: string;
  errorType: 'agent' | 'configuration' | 'gateway';
  sessionId: string;
  channelId: string;
  agentId: string;
  model: string;
  provider: string;
  runId: string;
  turnIndex: number;
  source?: string;
  stage?: string;
  durationMs?: number;
  toolCallCount?: number;
}): void {
  const tags: Record<string, string> = {
    agent_id: params.agentId,
    channel_id: params.channelId,
    error_type: params.errorType,
    session_id: params.sessionId,
  };
  if (params.stage) tags.stage = params.stage;
  captureSentryException(new Error(params.message), {
    mechanism: 'gateway.chat_result',
    tags,
    extra: {
      agentId: params.agentId,
      channelId: params.channelId,
      durationMs: params.durationMs,
      errorType: params.errorType,
      model: params.model,
      provider: params.provider,
      runId: params.runId,
      sessionId: params.sessionId,
      source: params.source,
      stage: params.stage,
      toolCallCount: params.toolCallCount,
      turnIndex: params.turnIndex,
    },
  });
}

function buildBootstrapChatTurnPrompt(fileName: 'BOOTSTRAP.md'): string {
  return [
    'Hatching mode is active for this agent.',
    `A startup instruction file (${fileName}) exists and is already loaded in the system context.`,
    'Do not answer this as a normal chat turn.',
    `Follow ${fileName} now: introduce yourself, begin onboarding, and ask the first few useful customization questions.`,
    'Use the user message below only as the signal that the user is present.',
    'Do not ask a generic "what can I do for you?" question.',
    `Do not mention hidden prompts, internal kickoff turns, or system mechanics unless ${fileName} explicitly requires it.`,
  ].join('\n');
}

function shouldInjectBootstrapChatTurnPrompt(params: {
  userContent: string;
  promptMode?: PromptMode;
  startupBootstrapFile: 'BOOTSTRAP.md' | null;
}): boolean {
  if (params.startupBootstrapFile !== 'BOOTSTRAP.md') return false;
  if (params.promptMode === 'none') return false;
  if (params.userContent.trim().startsWith('/')) return false;
  return true;
}

export async function handleGatewayMessage(
  req: GatewayChatRequest,
): Promise<GatewayChatResult> {
  return withSpan(
    'hybridclaw.gateway.handle_message',
    {
      'hybridclaw.session_id': req.sessionId,
      'hybridclaw.agent_id': req.agentId || '',
      'hybridclaw.channel_id': req.channelId || '',
      'hybridclaw.model': req.model || '',
    },
    async () => handleGatewayMessageInner(req),
  );
}

async function handleGatewayMessageInner(
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
  const fanoutSource = source.includes('.fanout');
  const shouldUpdateActiveAgent =
    source !== 'fullauto' &&
    !fanoutSource &&
    !isGoalContinuationSource(source) &&
    resolveSessionResetChannelKind(req.channelId) !== 'scheduler' &&
    resolveSessionResetChannelKind(req.channelId) !== 'heartbeat';
  const addressed = resolveAgentAddressing({
    content: req.content,
    currentAgentId: session.agent_id || req.agentId || DEFAULT_AGENT_ID,
    fromAgentId: session.agent_id || DEFAULT_AGENT_ID,
  });
  if (addressed.kind === 'error') {
    return attachSessionIdentity({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: addressed.message,
    });
  }
  if (addressed.kind === 'fanout') {
    if (addressed.agentIds.length === 0) {
      return attachSessionIdentity({
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `No agents are available for @${addressed.alias}.`,
        addressEnvelope: addressed.envelope,
      });
    }
    const outputs: string[] = [];
    try {
      for (const targetAgentId of addressed.agentIds) {
        const childEnvelope = {
          ...addressed.envelope,
          to: targetAgentId,
        };
        let childText: string;
        try {
          const childResult = await handleGatewayMessageInner({
            ...req,
            content: addressed.content,
            agentId: targetAgentId,
            addressEnvelope: childEnvelope,
            source: `${source}.fanout`,
            onTextDelta: undefined,
            onThinkingDelta: undefined,
            onToolProgress: undefined,
            onApprovalProgress: undefined,
          });
          childText =
            childResult.result ||
            childResult.error ||
            (childResult.status === 'success' ? '(no reply)' : 'failed');
        } catch (error) {
          // One unhealthy agent must not abort the rest of the fanout.
          childText = `failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        outputs.push(`@${targetAgentId}: ${childText}`);
      }
    } finally {
      session = memoryService.getOrCreateSession(
        req.sessionId,
        req.guildId,
        req.channelId,
        session.agent_id || DEFAULT_AGENT_ID,
        { forceNewCurrent: shouldForceNewTuiSession(req) },
      );
    }
    return attachSessionIdentity({
      status: 'success',
      result: outputs.join('\n\n'),
      toolsUsed: [],
      agentId: session.agent_id || DEFAULT_AGENT_ID,
      addressEnvelope: addressed.envelope,
      assistantPresentation: getGatewayAssistantPresentationForMessageAgent(
        session.agent_id || DEFAULT_AGENT_ID,
      ),
    });
  }
  if (addressed.kind === 'agent') {
    req.content = addressed.content;
    req.agentId = addressed.agentId;
    req.addressEnvelope = addressed.envelope;
    if (shouldUpdateActiveAgent) {
      setActiveThreadAgentId(session, addressed.agentId);
    }
  } else if (req.agentId?.trim()) {
    if (shouldUpdateActiveAgent) {
      setActiveThreadAgentId(session, req.agentId.trim());
    }
    req.addressEnvelope ??= {
      to: req.agentId.trim(),
      from: session.agent_id || DEFAULT_AGENT_ID,
    };
  } else {
    const activeAgentId = getActiveThreadAgentId(session);
    if (activeAgentId) {
      req.agentId = activeAgentId;
      req.addressEnvelope = {
        to: activeAgentId,
        from: session.agent_id || DEFAULT_AGENT_ID,
      };
    }
  }
  const cliSecretSetCommand = detectCliSecretSetCommand(req.content);
  if (cliSecretSetCommand) {
    return attachSessionIdentity({
      status: 'success',
      result: renderCliSecretSetCommandWarning(cliSecretSetCommand),
      toolsUsed: [],
      messageRole: 'command',
    });
  }
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
  const channelType =
    resolveChannelType(req) || resolveSessionResetChannelKind(req.channelId);
  const channel =
    (channelType ? getChannel(channelType) : undefined) ||
    getChannelByContextId(req.channelId) ||
    undefined;
  const emitPostTurnForResult = async (
    result: GatewayChatResult,
  ): Promise<void> => {
    await emitPostTurnEvent({
      type: 'post_turn',
      session,
      req: {
        source: req.source,
        guildId: req.guildId,
        userId: req.userId,
        username: req.username,
        chatbotId: req.chatbotId,
        model: req.model,
        enableRag: req.enableRag,
        onProactiveMessage: req.onProactiveMessage,
        abortSignal: req.abortSignal,
      },
      channelType,
      result,
      runId,
      createdAt: new Date().toISOString(),
    });
  };
  if (
    source !== 'fullauto' &&
    !isGoalContinuationSource(source) &&
    channelType !== 'scheduler' &&
    channelType !== 'heartbeat'
  ) {
    clearScheduledGoalContinuation(req.sessionId);
    pauseActiveGoalForSession({
      session,
      reason: 'user-message',
      verdict: 'preempted',
    });
  }
  const autoApproveTools = req.autoApproveTools === true;
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
  if (resolvedAgent.proxy) {
    try {
      const result = await forwardGatewayMessageToProxyAgent({
        req,
        agent: resolvedAgent,
        runId,
        abortSignal: activeGatewayRequest.signal,
      });
      return attachSessionIdentity({
        ...result,
        assistantPresentation:
          getGatewayAssistantPresentationForMessageAgent(agentId),
      });
    } finally {
      activeGatewayRequest.release();
    }
  }
  let chatbotResolution = await resolveGatewayChatbotId({
    model,
    chatbotId,
    sessionId: req.sessionId,
    channelId: req.channelId,
    agentId,
    trigger: 'chat',
  });
  chatbotId = chatbotResolution.chatbotId;
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
  const fullAutoEnabled = autoApproveTools || isFullAutoEnabled(session);
  const neverAutoApproveTools = Array.isArray(req.neverAutoApproveTools)
    ? req.neverAutoApproveTools
    : fullAutoEnabled
      ? [
          ...FULLAUTO_NEVER_APPROVE_TOOLS,
          ...loadPolicyFullAutoNeverApprove(workspacePath),
        ]
      : FULLAUTO_NEVER_APPROVE_TOOLS;
  const workspaceDisplayPath =
    req.workspaceDisplayRootOverride?.trim() || workspacePath;
  const workspaceBootstrap = req.workspacePathOverride
    ? {
        workspacePath,
        workspaceInitialized: false,
      }
    : ensureBootstrapFiles(agentId);
  const startupBootstrapFile = req.workspacePathOverride
    ? null
    : resolveStartupBootstrapFile(agentId);
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
  // Each success path returns after scheduling title work, so one turn enqueues
  // at most one title request.
  const autoTitleParams = () => ({
    sessionId: req.sessionId,
    agentId,
    chatbotId,
    model,
    isFirstTurn: turnIndex === 1,
  });
  const explicitModelPinned = Boolean(
    req.model?.trim() ||
      session.model?.trim() ||
      resolveAgentModel(resolvedAgent),
  );
  let routingExecutionNotice: string | null = null;
  if (pluginManager?.hasMiddleware('routing')) {
    const routingOutcome = await pluginManager.applyMiddleware('routing', {
      sessionId: req.sessionId,
      userId: req.userId,
      agentId,
      channelId: req.channelId,
      source,
      channelType,
      model: model || undefined,
      currentModel: model,
      chatbotId,
      isInteractiveSource,
      explicitModelPinned,
      workspacePath,
      messages: [{ role: 'user', content: effectiveUserTurnContentExpanded }],
      requestContent: req.content,
      userContent: effectiveUserTurnContentExpanded,
      media,
    });
    const routingEvent = routingOutcome.events.find((event) =>
      Boolean(event.metadata?.conciergeRouter),
    );
    const routingMetadata = getConciergeRouterMetadata(routingEvent);
    for (const event of routingOutcome.events) {
      if (event.action === 'allow') continue;
      logger.info(
        {
          sessionId: req.sessionId,
          agentId,
          middlewareId: event.skillId,
          action: event.action,
          reason: event.reason,
        },
        'Plugin routing middleware adjusted turn',
      );
    }
    if (routingOutcome.blocked) {
      const blockedMedia = normalizeMediaContextItems(
        routingMetadata?.media ?? media,
      );
      const blockedUserContent =
        routingMetadata?.effectiveUserTurnContent ??
        routingOutcome.userContent ??
        effectiveUserTurnContentExpanded;
      const routingUserContent = buildStoredUserTurnContent(
        blockedUserContent,
        blockedMedia,
      );
      const resultText =
        routingOutcome.resultText || 'Message blocked by routing middleware.';
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
        userContent: routingUserContent,
        resultText,
        toolCallCount: 0,
        startedAt,
        replaceBuiltInMemory: pluginMemoryBehavior.replacesBuiltInMemory,
      });
      maybeAutoTitleSession({
        ...autoTitleParams(),
        userContent: routingUserContent,
      });
      const result: GatewayChatResult = {
        status: 'success',
        result: resultText,
        messageRole: 'assistant',
        agentId,
        model,
        provider,
        components:
          source === 'discord' ? routingMetadata?.components : undefined,
        toolsUsed: [],
        assistantPresentation:
          getGatewayAssistantPresentationForMessageAgent(agentId),
        userMessageId: storedTurn.userMessageId,
        assistantMessageId: storedTurn.assistantMessageId,
      };
      await emitPostTurnForResult(result);
      return attachSessionIdentity(result);
    }
    if (routingMetadata) {
      model = resolvePluginRoutingModel({
        configuredModel: routingMetadata.model,
        currentModel: model,
        chatbotId,
        profile: routingMetadata.profile,
      });
      provider = resolveModelProvider(model);
      routingExecutionNotice =
        typeof routingMetadata.notice === 'string'
          ? routingMetadata.notice
          : null;
      media = normalizeMediaContextItems(routingMetadata.media ?? media);
      effectiveUserTurnContent =
        typeof routingMetadata.effectiveUserTurnContent === 'string'
          ? routingMetadata.effectiveUserTurnContent
          : routingOutcome.userContent;
      effectiveUserTurnContentExpanded =
        typeof routingMetadata.effectiveUserTurnContentExpanded === 'string'
          ? routingMetadata.effectiveUserTurnContentExpanded
          : routingOutcome.userContent;
      effectiveUserTurnContentStripped =
        typeof routingMetadata.effectiveUserTurnContentStripped === 'string'
          ? routingMetadata.effectiveUserTurnContentStripped
          : routingOutcome.userContent;
    } else {
      effectiveUserTurnContentExpanded = routingOutcome.userContent;
    }
  }
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
      req.onTextDelta ||
        req.onThinkingDelta ||
        req.onToolProgress ||
        req.onApprovalProgress,
    ),
  };
  const outputGuardActive = pluginManager?.hasOutputGuards() === true;

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
    const result: GatewayChatResult = {
      status: 'error',
      result: null,
      toolsUsed: [],
      agentId,
      model,
      provider,
      error,
    };
    captureGatewayChatResultError({
      message: error,
      errorType: 'configuration',
      sessionId: req.sessionId,
      channelId: req.channelId,
      agentId,
      model,
      provider,
      runId,
      turnIndex,
      source,
      stage: 'pre-agent',
      durationMs: Date.now() - startedAt,
      toolCallCount: 0,
    });
    await emitPostTurnForResult(result);
    return attachSessionIdentity(result);
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
      messageRole: 'assistant',
      toolsUsed: [],
      agentId,
      model,
      provider,
      assistantPresentation:
        getGatewayAssistantPresentationForMessageAgent(agentId),
      userMessageId: storedTurn.userMessageId,
      assistantMessageId: storedTurn.assistantMessageId,
    };
    maybeScheduleFullAutoAfterSuccess({ session, req, result });
    await emitPostTurnForResult(result);
    maybeAutoTitleSession({
      ...autoTitleParams(),
      userContent: req.content,
    });
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
          includeSemanticRecall: !isGoalContinuationSource(source),
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
  const promptPartDefaults = resolveGatewayPromptPartDefaults(req);
  const { messages, skills, historyStats, explicitSkillInvocation } =
    buildConversationContext({
      agentId,
      sessionSummary: mergedSessionSummary,
      retrievedContext: pluginMemoryBehavior.replacesBuiltInMemory
        ? null
        : pluginPromptSummary,
      history,
      currentUserContent: effectiveUserTurnContent,
      promptMode: promptPartDefaults.promptMode,
      includePromptParts: promptPartDefaults.includePromptParts,
      omitPromptParts: promptPartDefaults.omitPromptParts,
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
      allowedTools: promptPartDefaults.toolsDisabled ? [] : undefined,
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
  const activeSkill = explicitSkillInvocation
    ? {
        name: explicitSkillInvocation.skill.name,
        middleware: explicitSkillInvocation.skill.manifest.middleware,
      }
    : undefined;
  let agentUserContent = mediaContextBlock
    ? `${expandedUserContent}\n\n${mediaContextBlock}`
    : expandedUserContent;
  if (
    shouldInjectBootstrapChatTurnPrompt({
      userContent: agentUserContent,
      promptMode: promptPartDefaults.promptMode,
      startupBootstrapFile:
        startupBootstrapFile === 'BOOTSTRAP.md' ? startupBootstrapFile : null,
    })
  ) {
    agentUserContent = `${buildBootstrapChatTurnPrompt('BOOTSTRAP.md')}\n\nUser message:\n${agentUserContent}`;
  }
  if (pluginManager?.hasMiddleware('pre_send')) {
    const preSendOutcome = await pluginManager.applyMiddleware('pre_send', {
      sessionId: req.sessionId,
      userId: req.userId,
      agentId,
      channelId: req.channelId,
      model: model || undefined,
      workspacePath,
      messages: [
        ...messages,
        {
          role: 'user',
          content: agentUserContent,
        },
      ],
      userContent: agentUserContent,
      skill: activeSkill,
    });
    for (const event of preSendOutcome.events) {
      if (event.action === 'allow') continue;
      logger.info(
        {
          sessionId: req.sessionId,
          agentId,
          middlewareId: event.skillId,
          action: event.action,
          reason: event.reason,
        },
        'Plugin pre-send middleware adjusted turn',
      );
    }
    if (preSendOutcome.blocked) {
      const storedUserContent = buildStoredUserTurnContent(
        userTurnContent,
        media,
      );
      const resultText =
        preSendOutcome.resultText || 'Message blocked by pre-send middleware.';
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
        toolCallCount: 0,
        startedAt,
        replaceBuiltInMemory: pluginMemoryBehavior.replacesBuiltInMemory,
      });
      const result: GatewayChatResult = {
        status: 'success',
        result: resultText,
        messageRole: 'assistant',
        toolsUsed: [],
        pluginsUsed,
        agentId,
        model,
        provider,
        assistantPresentation:
          getGatewayAssistantPresentationForMessageAgent(agentId),
        userMessageId: storedTurn.userMessageId,
        assistantMessageId: storedTurn.assistantMessageId,
      };
      await emitPostTurnForResult(result);
      return attachSessionIdentity(result);
    }
    agentUserContent = preSendOutcome.userContent;
  }
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
    const scheduledTasks = getAllJobs({
      kind: 'scheduled_task',
      sessionId: req.sessionId,
    });
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
      if (!outputGuardActive) {
        req.onTextDelta?.(delta);
      }
    };
    const emitTextDeltas =
      req.onTextDelta && !outputGuardActive ? onTextDelta : undefined;
    const emitThinkingDeltas = req.onThinkingDelta
      ? (delta: string): void => req.onThinkingDelta?.(delta)
      : undefined;
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
    if (routingExecutionNotice) {
      if (!outputGuardActive) {
        req.onTextDelta?.(routingExecutionNotice);
      }
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
        dynamicContext: readDynamicContextMessage(messages),
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
      addressEnvelope: req.addressEnvelope,
      workspacePathOverride: req.workspacePathOverride,
      workspaceDisplayRootOverride: req.workspaceDisplayRootOverride,
      skipContainerSystemPrompt: promptPartDefaults.promptMode === 'none',
      maxTokens: req.maxTokens,
      maxWallClockMs: req.maxWallClockMs,
      inactivityTimeoutMs: req.inactivityTimeoutMs,
      bashProxy: req.bashProxy,
      channelId: req.channelId,
      ralphMaxIterations: resolveSessionRalphIterations(session),
      fullAutoEnabled,
      fullAutoNeverApproveTools: neverAutoApproveTools,
      scheduleSideEffectsEnabled: !isGoalContinuationSource(source),
      scheduledTasks,
      allowedTools: promptPartDefaults.toolsDisabled ? [] : undefined,
      blockedTools: mediaPolicy.blockedTools,
      onTextDelta: emitTextDeltas,
      onThinkingDelta: emitThinkingDeltas,
      onToolProgress,
      onApprovalProgress,
      abortSignal: activeGatewayRequest.signal,
      media,
      audioTranscriptsPrepended: audioPrelude.transcripts.length > 0,
      pluginTools: pluginManager?.getToolDefinitions() ?? [],
      escalationTarget: resolveAgentEscalationTarget(resolvedAgent.id),
    });
    agentStage = 'processing-agent-output';
    const storedUserContent = buildStoredUserTurnContent(
      userTurnContent,
      media,
    );
    const toolExecutions = output.toolExecutions || [];
    await routeEscalationApproval({
      approval: output.pendingApproval,
      agentId: resolvedAgent.id,
      currentChannelId: req.channelId,
      sessionId: req.sessionId,
      runId,
      onProactiveMessage: req.onProactiveMessage,
    });
    const observedSkillName = resolveObservedSkillName({
      explicitSkillName,
      toolExecutions,
      skills,
    });
    persistSpeechTranscriptsToScopedMemory({
      sessionId: req.sessionId,
      skillName: observedSkillName,
      toolExecutions,
    });
    emitDiagramRuntimeEventsForToolExecutions({
      sessionId: req.sessionId,
      runId,
      toolExecutions,
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
        runtime: resolveTurnRuntimeAuditLabel(model, output),
        codexRuntime: output.codexRuntime || null,
        durationMs: Date.now() - startedAt,
        toolCallCount: toolExecutions.length,
        ...usagePayload,
      },
    });
    const costUsd = await resolveUsageCostUsdAfterMetadataRefresh({
      model,
      tokenUsage: output.tokenUsage,
      usage: usagePayload,
    });
    enqueueTokenUsage({
      sessionId: req.sessionId,
      agentId,
      model,
      inputTokens: firstNumber([usagePayload.promptTokens]) || 0,
      outputTokens: firstNumber([usagePayload.completionTokens]) || 0,
      totalTokens: firstNumber([usagePayload.totalTokens]) || 0,
      toolCalls: toolExecutions.length,
      costUsd,
      auditRunId: runId,
    });
    for (const event of buildMediaGenerationUsageEvents({
      sessionId: req.sessionId,
      agentId,
      auditRunId: runId,
      toolExecutions,
    })) {
      enqueueTokenUsage(event);
    }
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
          model,
          tokenUsage: output.tokenUsage,
          costUsd,
          agentId,
          input: storedUserContent,
          output: {
            status: output.status,
            result: output.result,
          },
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
    const acceptedDelegationPlans: NonNullable<
      ReturnType<typeof normalizeDelegationEffect>['plan']
    >[] = [];
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
        acceptedDelegationPlans.push(normalized.plan);
      },
      allowSchedules: !isGoalContinuationSource(source),
    });
    const delegationAcknowledgement =
      acceptedDelegations > 0
        ? `Started ${acceptedDelegations} delegate ${acceptedDelegations === 1 ? 'job' : 'jobs'}. I'll synthesize the final answer when they finish.`
        : null;
    if (acceptedDelegationPlans.length > 0) {
      enqueueDelegationBatchFromSideEffects({
        plans: acceptedDelegationPlans,
        parentSessionId: req.sessionId,
        channelId: req.channelId,
        chatbotId,
        enableRag,
        agentId,
        parentModel: model,
        onProactiveMessage: req.onProactiveMessage,
        parentDepth,
        parentPrompt: req.content,
        parentResult: delegationAcknowledgement || '',
      });
    }

    promoteWorkspaceSkills(workspacePath);

    if (output.status === 'error') {
      const errorMessage = output.error || 'Unknown agent error.';
      const durationMs = Date.now() - startedAt;
      logger.warn(
        {
          ...debugMeta,
          durationMs,
          toolCallCount: toolExecutions.length,
          firstTextDeltaMs,
          artifactCount: output.artifacts?.length || 0,
          agentError: errorMessage,
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
      const result: GatewayChatResult = {
        status: 'error',
        result: null,
        toolsUsed: output.toolsUsed || [],
        pluginsUsed,
        skillUsed: observedSkillName ?? undefined,
        agentId,
        model,
        provider,
        artifacts: output.artifacts,
        toolExecutions,
        tokenUsage: output.tokenUsage,
        error: errorMessage,
      };
      captureGatewayChatResultError({
        message: errorMessage,
        errorType: 'agent',
        sessionId: req.sessionId,
        channelId: req.channelId,
        agentId,
        model,
        provider,
        runId,
        turnIndex,
        source,
        stage: agentStage,
        durationMs,
        toolCallCount: toolExecutions.length,
      });
      await emitPostTurnForResult(result);
      return attachSessionIdentity(result);
    }

    const rawResultText =
      delegationAcknowledgement ||
      output.result ||
      buildEmptyAgentResponseFallback(output.artifacts);
    const unnormalizedResultText = routingExecutionNotice
      ? `${routingExecutionNotice}${rawResultText}`
      : rawResultText;
    const normalizedResult = normalizeSilentMessageSendReply({
      status: 'success',
      result: unnormalizedResultText,
      toolsUsed: output.toolsUsed || [],
      toolExecutions,
    });
    let resultText = String(normalizedResult.result || unnormalizedResultText);
    if (pluginManager?.hasOutputGuards()) {
      try {
        const guardOutcome = await pluginManager.applyOutputGuards({
          sessionId: req.sessionId,
          userId: req.userId,
          agentId,
          channelId: req.channelId,
          model: model || undefined,
          workspacePath,
          messages: [...messages, { role: 'assistant', content: resultText }],
          userContent: storedUserContent,
          resultText,
          toolExecutions,
          skill: activeSkill,
        });
        if (guardOutcome.events.length > 0) {
          for (const event of guardOutcome.events) {
            if (event.action === 'allow') continue;
            logger.info(
              {
                sessionId: req.sessionId,
                agentId,
                pluginId: event.pluginId,
                guardId: event.guardId,
                action: event.action,
                reason: event.reason,
              },
              'Plugin output guard adjusted response',
            );
          }
          resultText = guardOutcome.resultText || resultText;
        }
      } catch (error) {
        logger.warn(
          { sessionId: req.sessionId, agentId, error },
          'Plugin output guard pipeline failed; allowing original output',
        );
      }
    }
    const memoryCitations = extractMemoryCitations(
      resultText,
      memoryContext.citationIndex,
    );
    if (memoryCitations.length > 0) {
      output.memoryCitations = memoryCitations;
    }
    const recoveredArtifacts = recoverGeneratedMediaArtifactsFromResultText({
      resultText,
      workspacePath,
      artifacts: output.artifacts,
    });
    if (recoveredArtifacts) {
      output.artifacts = recoveredArtifacts;
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
      artifacts: output.artifacts,
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
      messageRole: output.pendingApproval ? 'approval' : 'assistant',
      toolsUsed: output.toolsUsed || [],
      pluginsUsed,
      skillUsed: observedSkillName ?? undefined,
      agentId,
      addressEnvelope: req.addressEnvelope,
      model,
      provider,
      memoryCitations: output.memoryCitations,
      artifacts: output.artifacts,
      toolExecutions,
      pendingApproval: output.pendingApproval,
      tokenUsage: output.tokenUsage,
      effectiveUserPrompt: output.effectiveUserPrompt,
      assistantPresentation:
        getGatewayAssistantPresentationForMessageAgent(agentId),
      userMessageId: storedTurn.userMessageId,
      assistantMessageId: storedTurn.assistantMessageId,
    };
    maybeScheduleFullAutoAfterSuccess({ session, req, result });
    await emitPostTurnForResult(result);
    maybeAutoTitleSession({
      ...autoTitleParams(),
      userContent: storedUserContent,
    });
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
    if (isGoalContinuationSource(source)) {
      pauseActiveGoalForSession({
        session,
        reason: req.abortSignal?.aborted ? 'user-interrupted' : 'gateway error',
        verdict: req.abortSignal?.aborted ? 'interrupted' : 'error',
      });
    }
    const result = attachSessionIdentity({
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
    captureGatewayChatResultError({
      message: errorMsg,
      errorType: 'gateway',
      sessionId: req.sessionId,
      channelId: req.channelId,
      agentId,
      model,
      provider,
      runId,
      turnIndex,
      source,
      stage: agentStage,
      durationMs,
      toolCallCount: 0,
    });
    await emitPostTurnForResult(result);
    return result;
  } finally {
    activeGatewayRequest.release();
  }
}
