/**
 * Worker input — the `ContainerInput` a request sends and the signature that
 * decides whether a session's live worker can take it.
 *
 * Everything that changes what a running worker was started with (provider,
 * credentials, gateway token, workspace, bash proxy, stored runtime env when
 * it travels with the request) is in the signature, so a change restarts the
 * worker instead of reusing it. Pure: resolves nothing asynchronous and
 * starts no process; the runner supplies model runtime and MCP servers.
 */
import { resolveProviderRequestMaxTokens } from '@hybridclaw/shared/request-max-tokens';
import type { ExecutorRequest } from '../agent/executor-types.js';
import {
  resolveLocalStarterTools,
  resolveLocalToolMode,
  resolveMcpToolMode,
} from '../agent/local-tool-config.js';
import { mergeAllowedToolNames } from '../agent/tool-policy.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { resolveEmailSenderAddress } from '../channels/email/sender-address.js';
import { collectActiveMessageToolChannelKinds } from '../channels/message-tool-advertising.js';
import {
  BROWSER_ALLOW_PRIVATE_NETWORK,
  BROWSER_PROVIDER,
  CONTAINER_PERSIST_BASH_STATE,
  CONTEXT_GUARD_COMPACTION_RATIO,
  CONTEXT_GUARD_ENABLED,
  CONTEXT_GUARD_MAX_RETRIES,
  CONTEXT_GUARD_OVERFLOW_RATIO,
  DISCORD_FREE_RESPONSE_CHANNELS,
  DISCORD_GUILDS,
  DISCORD_SEND_ALLOWED_CHANNEL_IDS,
  GATEWAY_CLIENT_BASE_URL,
  HYBRIDAI_MODEL,
} from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import type { resolveModelRuntimeCredentials } from '../providers/factory.js';
import { resolveSupportedReasoningEffort } from '../providers/model-catalog.js';
import type { resolveTaskModelPolicies } from '../providers/task-routing.js';
import { resolveWorkerRuntimeToken } from '../security/agent-runtime-token.js';
import type { ContainerInput } from '../types/container.js';
import type { McpServerConfig } from '../types/models.js';
import { isModelResponseDebugEnabled } from './model-response-debug.js';
import { resolveWebSearchRuntimeConfig } from './web-search-runtime-config.js';
import { computeWorkerSignature } from './worker-signature.js';

export type ModelRuntime = Awaited<
  ReturnType<typeof resolveModelRuntimeCredentials>
>;

export function collectConfiguredDiscordChannelIds(
  currentChannelId: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string | undefined | null) => {
    const id = String(value || '').trim();
    if (!/^\d{16,22}$/.test(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  add(currentChannelId);
  for (const id of DISCORD_SEND_ALLOWED_CHANNEL_IDS) add(id);
  for (const id of DISCORD_FREE_RESPONSE_CHANNELS) add(id);
  for (const guildConfig of Object.values(DISCORD_GUILDS)) {
    for (const channelId of Object.keys(guildConfig.channels || {}))
      add(channelId);
  }
  return out;
}

export function buildWorkerInput(
  params: ExecutorRequest,
  context: {
    requestId: string;
    executionDeadlineAtMs?: number;
    modelRuntime: ModelRuntime;
    taskModels: Awaited<ReturnType<typeof resolveTaskModelPolicies>>;
    mcpServers: Record<string, McpServerConfig>;
    runtimeEnv?: Record<string, string>;
    mapHostUrl: (url: string) => string;
  },
): { input: ContainerInput; workerSignature: string } {
  const {
    sessionId,
    messages,
    model = HYBRIDAI_MODEL,
    agentId = DEFAULT_AGENT_ID,
    channelId = '',
    approvalUserText = null,
  } = params;
  const {
    requestId,
    executionDeadlineAtMs,
    modelRuntime,
    taskModels,
    mcpServers,
    runtimeEnv,
  } = context;
  const runtimeModel = modelRuntime.model || model;
  const webSearchRuntime = resolveWebSearchRuntimeConfig(agentId);
  const input: ContainerInput = {
    sessionId,
    executionDeadlineAtMs,
    fileWriteGuardSessionId: params.fileWriteGuardSessionId,
    fileWriteGuardUserPrompt: params.fileWriteGuardUserPrompt,
    runId: params.runId,
    toolCallLimits: params.toolCallLimits,
    requestId,
    agentId,
    messages,
    chatbotId: modelRuntime.chatbotId,
    enableRag: modelRuntime.enableRag,
    apiKey: modelRuntime.apiKey,
    baseUrl: context.mapHostUrl(modelRuntime.baseUrl),
    provider: modelRuntime.provider,
    addressEnvelope: params.addressEnvelope,
    providerMethod: modelRuntime.providerMethod,
    requestHeaders: modelRuntime.requestHeaders,
    isLocal: modelRuntime.isLocal,
    contextWindow: modelRuntime.contextWindow,
    modelBehavior: modelRuntime.modelBehavior,
    thinkingFormat: modelRuntime.thinkingFormat,
    gatewayBaseUrl: context.mapHostUrl(GATEWAY_CLIENT_BASE_URL),
    gatewayApiToken: resolveWorkerRuntimeToken(params.runtimeScope),
    browserProvider: params.browserProvider || BROWSER_PROVIDER,
    browserAllowPrivateNetwork: BROWSER_ALLOW_PRIVATE_NETWORK,
    model: runtimeModel,
    reasoningEffort: resolveSupportedReasoningEffort(
      modelRuntime.provider,
      runtimeModel,
      params.reasoningEffort,
    ),
    ralphMaxIterations: params.ralphMaxIterations,
    disabledSafetyRules: getRuntimeConfig().security.disabledSafetyRules,
    approvalMode: params.approvalMode,
    dryRun: params.dryRun,
    approvalUserText,
    approvalUserId: params.approvalUserId,
    approvalUserIsBot: params.approvalUserIsBot,
    approvalReplyDecision: params.approvalReplyDecision,
    fullAutoNeverApproveTools: params.fullAutoNeverApproveTools,
    scheduleSideEffectsEnabled: params.scheduleSideEffectsEnabled,
    skipContainerSystemPrompt: params.skipContainerSystemPrompt,
    streamTextDeltas: Boolean(params.onTextDelta),
    debugModelResponses: isModelResponseDebugEnabled(),
    maxTokens: resolveProviderRequestMaxTokens({
      model: runtimeModel,
      discoveredMaxTokens: modelRuntime.maxTokens,
    }),
    channelId,
    client: params.client,
    configuredDiscordChannels: collectConfiguredDiscordChannelIds(channelId),
    activeMessageChannels: collectActiveMessageToolChannelKinds(),
    emailSender: resolveEmailSenderAddress(agentId),
    skillCatalog: params.skillCatalog,
    localToolMode: modelRuntime.isLocal
      ? resolveLocalToolMode(agentId)
      : undefined,
    localStarterTools: modelRuntime.isLocal
      ? resolveLocalStarterTools(agentId)
      : undefined,
    mcpToolMode: modelRuntime.isLocal ? undefined : resolveMcpToolMode(agentId),
    allowedTools: mergeAllowedToolNames({
      agentId,
      explicit: params.allowedTools,
    }),
    blockedTools: params.blockedTools,
    media: params.media,
    readableMediaPaths: params.readableMediaPaths,
    visualMediaAllowed: params.visualMediaAllowed,
    primaryModelSupportsVisualMedia: params.primaryModelSupportsVisualMedia,
    audioTranscriptsPrepended: params.audioTranscriptsPrepended,
    pluginTools: params.pluginTools,
    mcpServers,
    taskModels,
    ...(runtimeEnv ? { runtimeEnv } : {}),
    contextGuard: {
      enabled: CONTEXT_GUARD_ENABLED,
      compactionRatio: CONTEXT_GUARD_COMPACTION_RATIO,
      overflowRatio: CONTEXT_GUARD_OVERFLOW_RATIO,
      maxRetries: CONTEXT_GUARD_MAX_RETRIES,
    },
    webSearch: webSearchRuntime,
    persistBashState: CONTAINER_PERSIST_BASH_STATE,
    escalationTarget: params.escalationTarget,
  };
  const workerSignature = computeWorkerSignature({
    agentId,
    gatewayApiToken: input.gatewayApiToken,
    webSearch: input.webSearch,
    provider: input.provider,
    providerMethod: input.providerMethod,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    requestHeaders: input.requestHeaders,
    modelBehavior: input.modelBehavior,
    thinkingFormat: input.thinkingFormat,
    browserProvider: params.browserProvider || BROWSER_PROVIDER,
    browserAllowPrivateNetwork: BROWSER_ALLOW_PRIVATE_NETWORK,
    taskModels: input.taskModels,
    runtimeEnv,
    workspacePathOverride: params.workspacePathOverride,
    workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
    bashProxy: params.bashProxy,
  });
  return { input, workerSignature };
}
