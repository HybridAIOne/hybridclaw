import path from 'node:path';
import {
  makeAuditRunId,
  type RecordAuditEventInput,
  recordAuditEvent,
} from '../audit/audit-events.js';
import type { ChannelInfo } from '../channels/channel.js';
import {
  type RuntimeConfig,
  runtimeConfigPath,
} from '../config/runtime-config.js';
import { resolveInstallRoot } from '../infra/install-root.js';
import { logger } from '../logger.js';
import type { AIProvider } from '../providers/types.js';
import type { PluginManager } from './plugin-manager.js';
import type {
  HybridClawPluginApi,
  MemoryLayerPlugin,
  PluginCommandDefinition,
  PluginDispatchInboundMessageRequest,
  PluginHookHandlerMap,
  PluginHookName,
  PluginInboundWebhookDefinition,
  PluginLogger,
  PluginPromptHook,
  PluginRegistrationMode,
  PluginRuntime,
  PluginService,
  PluginToolDefinition,
} from './plugin-types.js';

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value == null || typeof value !== 'object') return value;
  const objectValue = value as Record<PropertyKey, unknown>;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreeze(objectValue[key], seen);
  }
  return Object.freeze(value);
}

function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function createPluginApi(params: {
  manager: PluginManager;
  pluginId: string;
  pluginDir: string;
  registrationMode: PluginRegistrationMode;
  config: RuntimeConfig;
  pluginConfig: Record<string, unknown>;
  declaredEnv: readonly string[];
  homeDir: string;
  cwd: string;
}): HybridClawPluginApi {
  const pluginLogger = logger.child({
    pluginId: params.pluginId,
  }) as PluginLogger;
  const declaredEnv = new Set(
    params.declaredEnv
      .map((key) => (typeof key === 'string' ? key.trim() : ''))
      .filter((key) => key.length > 0),
  );
  const config = deepFreezeClone(params.config);
  const pluginConfig = deepFreezeClone(params.pluginConfig);
  const runtime: PluginRuntime = Object.freeze({
    cwd: params.cwd,
    homeDir: params.homeDir,
    installRoot: resolveInstallRoot(),
    runtimeConfigPath: runtimeConfigPath(),
  });

  return Object.freeze({
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
    registrationMode: params.registrationMode,
    config,
    pluginConfig,
    logger: pluginLogger,
    runtime,
    registerMemoryLayer(layer: MemoryLayerPlugin): void {
      params.manager.registerMemoryLayer(params.pluginId, layer);
    },
    registerProvider(provider: AIProvider): void {
      params.manager.registerProvider(params.pluginId, provider);
    },
    registerChannel(channel: ChannelInfo): void {
      params.manager.registerChannel(params.pluginId, channel);
    },
    registerTool(tool: PluginToolDefinition): void {
      params.manager.registerTool(params.pluginId, tool);
    },
    registerPromptHook(hook: PluginPromptHook): void {
      params.manager.registerPromptHook(params.pluginId, hook);
    },
    registerCommand(cmd: PluginCommandDefinition): void {
      params.manager.registerCommand(params.pluginId, cmd);
    },
    registerService(svc: PluginService): void {
      params.manager.registerService(params.pluginId, svc);
    },
    registerInboundWebhook(webhook: PluginInboundWebhookDefinition): void {
      params.manager.registerInboundWebhook(params.pluginId, webhook);
    },
    dispatchInboundMessage(
      request: PluginDispatchInboundMessageRequest,
    ): Promise<import('../gateway/gateway-types.js').GatewayChatResult> {
      return params.manager.dispatchInboundMessage(params.pluginId, request);
    },
    on<K extends PluginHookName>(
      event: K,
      handler: PluginHookHandlerMap[K],
      opts?: { priority?: number },
    ): void {
      params.manager.registerHook(params.pluginId, event, handler, opts);
    },
    createAuditRunId(prefix?: string): string {
      return makeAuditRunId(prefix);
    },
    recordAuditEvent(input: RecordAuditEventInput): void {
      recordAuditEvent(input);
    },
    resolvePath(relative: string): string {
      return path.resolve(params.pluginDir, relative);
    },
    getCredential(key: string): string | undefined {
      const normalized = String(key || '').trim();
      if (!normalized) return undefined;
      if (!declaredEnv.has(normalized)) return undefined;
      const value = process.env[normalized];
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed || undefined;
    },
  });
}
