/**
 * Public plugin SDK (`@hybridaione/hybridclaw/plugin-sdk`): the types and the
 * host services a plugin may call — audit, F4 revisions, confidential-rule
 * redaction, agent registry and workspace paths — so plugins reuse the core
 * implementation instead of copying it. Every value export has a plugin
 * caller in `plugins/`; plugin-facing behaviour lives on `HybridClawPluginApi`.
 */
export {
  getAgentById,
  upsertRegisteredAgent,
} from '../agents/agent-registry.js';
export { recordAuditEvent } from '../audit/audit-events.js';
export type { ChannelInfo } from '../channels/channel.js';
export type {
  ChannelTransportInstance,
  ChannelTransportMediaSendParams,
  ChannelTransportMessageContext,
  ChannelTransportMessageHandler,
  ChannelTransportPairingSession,
  ChannelTransportRegistration,
  ChannelTransportReplyFn,
  ChannelTransportSendResult,
  LineChannelTransportRegistration,
  WhatsAppChannelTransportRegistration,
} from '../channels/channel-transport.js';
export type { LineTransportHost } from '../channels/line/transport-host.js';
export {
  readWebhookBody,
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '../channels/webhook-http.js';
export type { WhatsAppTransportHost } from '../channels/whatsapp/transport-host.js';
export { parseValueFlag } from '../cli/common.js';
export { DATA_DIR } from '../config/config.js';
export type {
  RuntimeConfig,
  RuntimeLineConfig,
  RuntimeWhatsAppConfig,
} from '../config/runtime-config.js';
export {
  clearRuntimeAssetRevisions,
  type RuntimeRevisionAssetType,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
export type { GatewayChatResult } from '../gateway/gateway-types.js';
export { resolveInstallPath } from '../infra/install-root.js';
export { agentWorkspaceDir } from '../infra/ipc.js';
export type {
  EmbeddingProvider,
  EmbeddingProviderRegistration,
} from '../memory/embeddings.js';
export type { AIProvider } from '../providers/types.js';
export type {
  LocalClassifierAction,
  LocalClassifierInfo,
  LocalClassifierRegistration,
  LocalClassifierState,
} from '../routing/local-classifiers.js';
export {
  createPlaceholderMap,
  dehydrateConfidential,
  scanForLeaks,
} from '../security/confidential-redact.js';
export {
  type ConfidentialRuleSet,
  loadConfidentialRules,
  ruleHasContent,
} from '../security/confidential-rules.js';
export { isSkillContentEntry } from '../skills/skills-guard-structure.js';
export type { StoredMessage } from '../types/session.js';
export { ensureBootstrapFiles } from '../workspace.js';
export type {
  PluginMediaHost,
  PluginSessionModelCredentials,
} from './plugin-media-host.js';
export type {
  HybridClawPluginApi,
  HybridClawPluginDefinition,
  LoadedPlugin,
  MemoryLayerPlugin,
  PluginAdminRouteContext,
  PluginAdminRouteDefinition,
  PluginAfterToolCallContext,
  PluginAuxiliaryModelRequest,
  PluginAuxiliaryModelResult,
  PluginCandidate,
  PluginCliCommandDefinition,
  PluginCommandDefinition,
  PluginCompactionContext,
  PluginConfigSchema,
  PluginConfigUiHint,
  PluginDiscoverySource,
  PluginDispatchInboundMessageRequest,
  PluginGatewayLifecycleContext,
  PluginHookHandlerMap,
  PluginHookName,
  PluginInboundProactiveMessage,
  PluginInboundWebhookContext,
  PluginInboundWebhookDefinition,
  PluginKind,
  PluginLogger,
  PluginManifest,
  PluginMemoryBehavior,
  PluginMemoryFlushContext,
  PluginMemoryWriteAction,
  PluginMemoryWriteContext,
  PluginMiddlewareDecision,
  PluginMiddlewareSkill,
  PluginOutputGuard,
  PluginOutputGuardContext,
  PluginOutputGuardDecision,
  PluginOutputGuardEvent,
  PluginOutputGuardOutcome,
  PluginPhoneNotification,
  PluginPhoneNotificationResult,
  PluginPromptBuildContext,
  PluginPromptHook,
  PluginRealtimeVoiceCallerInfo,
  PluginRealtimeVoiceSession,
  PluginRealtimeVoiceSessionIdentity,
  PluginRealtimeVoiceSessionOptions,
  PluginRegistrationMode,
  PluginRuntime,
  PluginRuntimeToolDefinition,
  PluginService,
  PluginSessionResetContext,
  PluginSummary,
  PluginTokenUsage,
  PluginToolDefinition,
  PluginToolHandlerContext,
  PluginToolHookContext,
  PluginToolSchema,
  PluginToolSchemaProperty,
  PluginWebsocket,
  PluginWebsocketWebhookContext,
  PluginWebsocketWebhookDefinition,
} from './plugin-types.js';
export {
  buildPluginInboundWebhookPath,
  isPluginInboundWebhookPath,
  PLUGIN_INBOUND_WEBHOOK_PATH_PREFIX,
} from './plugin-webhooks.js';
