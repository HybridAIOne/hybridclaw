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
export type {
  BrowserProvider,
  BrowserSession,
  SessionOptions as BrowserSessionOptions,
} from '../browser/provider.js';
export type { BrowserProviderRegistration } from '../browser/provider-factory.js';
export type { BrowserProviderHost } from '../browser/provider-host.js';
export type { ChannelInfo } from '../channels/channel.js';
export type {
  ChannelTransportAuthStatus,
  ChannelTransportDoctorFinding,
  ChannelTransportHost,
  ChannelTransportInstance,
  ChannelTransportMediaSendParams,
  ChannelTransportMessageContext,
  ChannelTransportMessageHandler,
  ChannelTransportPairingSession,
  ChannelTransportPairingState,
  ChannelTransportRegistration,
  ChannelTransportReplyFn,
  ChannelTransportSendDescription,
  ChannelTransportSendResult,
} from '../channels/channel-transport.js';
export {
  readWebhookBody,
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '../channels/webhook-http.js';
// compat: remove after v0.41 — hybridclaw-whatsapp 0.1.x types its transport
// against this host, so its source must keep typechecking until it migrates.
export type { WhatsAppTransportHost } from '../channels/whatsapp/legacy-registration.js';
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
