import path from 'node:path';
import type { ChannelInfo } from '../channels/channel.js';
import {
  type RuntimeConfig,
  runtimeConfigPath,
} from '../config/runtime-config.js';
import { resolveInstallRoot } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { getRecentMessages, getSessionById } from '../memory/db.js';
import type { AIProvider } from '../providers/types.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import { parseSessionKey } from '../session/session-key.js';
import type { McpServerConfig } from '../types/models.js';
import {
  unsetPluginConfigValue,
  writePluginConfigValue,
} from './plugin-config.js';
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
  const defaultAgentId =
    String(params.config.agents?.defaultAgentId || 'main').trim() || 'main';
  const resolvePluginSessionAgentId = (sessionId: string): string => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return defaultAgentId;

    let sessionAgentId = '';
    try {
      sessionAgentId = String(
        getSessionById(normalizedSessionId)?.agent_id || '',
      ).trim();
    } catch {
      sessionAgentId = '';
    }
    if (sessionAgentId) return sessionAgentId;

    const parsed = parseSessionKey(normalizedSessionId);
    if (parsed?.agentId) return parsed.agentId;

    return defaultAgentId;
  };
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
    resolvePath(relative: string): string {
      return path.resolve(params.pluginDir, relative);
    },
    getCredential(key: string): string | undefined {
      const normalized = String(key || '').trim();
      if (!normalized) return undefined;
      if (!declaredEnv.has(normalized)) return undefined;
      const value = process.env[normalized];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
      const stored = readStoredRuntimeSecret(normalized);
      return stored?.trim() || undefined;
    },
    getMcpServerConfig(name: string): Readonly<McpServerConfig> | null {
      return params.manager.getMcpServerConfig(name);
    },
    async writeConfigValue(key: string, rawValue: string): Promise<void> {
      await writePluginConfigValue(params.pluginId, key, rawValue, {
        homeDir: params.homeDir,
        cwd: params.cwd,
      });
    },
    async unsetConfigValue(key: string): Promise<void> {
      await unsetPluginConfigValue(params.pluginId, key, {
        homeDir: params.homeDir,
        cwd: params.cwd,
      });
    },
    resolveSessionAgentId(sessionId: string): string {
      return resolvePluginSessionAgentId(sessionId);
    },
    getSessionInfo(sessionId: string): {
      sessionId: string;
      agentId: string;
      userId: string | null;
      workspacePath: string;
    } {
      const normalizedSessionId = String(sessionId || '').trim();
      const agentId = resolvePluginSessionAgentId(normalizedSessionId);
      let userId: string | null = null;
      if (normalizedSessionId) {
        try {
          const recentMessages = getRecentMessages(normalizedSessionId, 200);
          const userMessage = recentMessages.find(
            (message) =>
              String(message.role || '')
                .trim()
                .toLowerCase() === 'user' &&
              String(message.user_id || '').trim().length > 0,
          );
          userId = userMessage?.user_id?.trim() || null;
        } catch {
          userId = null;
        }
      }
      return {
        sessionId: normalizedSessionId,
        agentId,
        userId,
        workspacePath: agentWorkspaceDir(agentId),
      };
    },
  });
}
