import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ChannelInfo } from '../channels/channel.js';
import {
  listChannels,
  registerChannel,
  unregisterChannel,
} from '../channels/channel-registry.js';
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { logger as rootLogger } from '../logger.js';
import type { AIProvider } from '../providers/types.js';
import type { StoredMessage } from '../types.js';
import { createPluginApi } from './plugin-api.js';
import type {
  HybridClawPluginDefinition,
  LoadedPlugin,
  MemoryLayerPlugin,
  PluginAgentEndContext,
  PluginCandidate,
  PluginCommandDefinition,
  PluginCompactionContext,
  PluginConfigSchema,
  PluginHookHandlerMap,
  PluginHookName,
  PluginLogger,
  PluginManifest,
  PluginMemoryFlushContext,
  PluginPromptBuildContext,
  PluginPromptHook,
  PluginRegistrationMode,
  PluginRuntimeToolDefinition,
  PluginService,
  PluginSummary,
  PluginSessionResetContext,
  PluginToolDefinition,
  PluginToolHandlerContext,
  PluginToolSchema,
} from './plugin-types.js';

const MANIFEST_FILE_NAME = 'hybridclaw.plugin.yaml';
const DEFAULT_ENTRYPOINT_CANDIDATES = [
  'index.js',
  'index.mjs',
  'index.cjs',
  path.join('dist', 'index.js'),
  'index.ts',
];

type RuntimePluginConfigEntryLike = {
  id: string;
  enabled: boolean;
  path?: string;
  config: Record<string, unknown>;
};

type RegisteredMemoryLayer = {
  pluginId: string;
  layer: MemoryLayerPlugin;
};

type RegisteredPromptHook = {
  pluginId: string;
  hook: PluginPromptHook;
};

type RegisteredTool = {
  pluginId: string;
  tool: PluginToolDefinition;
  logger: PluginLogger;
};

type RegisteredService = {
  pluginId: string;
  service: PluginService;
};

type RegisteredHook<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  priority: number;
  handler: PluginHookHandlerMap[K];
};

type RegisteredCommand = {
  pluginId: string;
  command: PluginCommandDefinition;
};

type RegisteredProvider = {
  pluginId: string;
  provider: AIProvider;
};

type RegisteredChannel = {
  pluginId: string;
  channel: ChannelInfo;
};

type PluginRegistrationSnapshot = {
  memoryLayers: RegisteredMemoryLayer[];
  promptHooks: RegisteredPromptHook[];
  services: RegisteredService[];
  providers: RegisteredProvider[];
  channels: RegisteredChannel[];
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  hooks: Map<PluginHookName, RegisteredHook[]>;
  registeredChannels: ChannelInfo[];
};

export interface ExecutePluginToolParams {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  channelId: string;
}

export interface PluginManagerOptions {
  homeDir?: string;
  cwd?: string;
  getRuntimeConfig?: () => RuntimeConfig;
  logger?: PluginLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim();
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

function toPluginConfigEntries(
  config: RuntimeConfig,
): RuntimePluginConfigEntryLike[] {
  const raw = (
    config as RuntimeConfig & {
      plugins?: { list?: RuntimePluginConfigEntryLike[] };
    }
  ).plugins?.list;
  if (!Array.isArray(raw)) return [];
  return raw;
}

function normalizeManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) {
    throw new Error('Plugin manifest must be a YAML object.');
  }

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) {
    throw new Error('Plugin manifest is missing `id`.');
  }

  return {
    id,
    name: typeof input.name === 'string' ? input.name.trim() : undefined,
    version:
      typeof input.version === 'string' ? input.version.trim() : undefined,
    description:
      typeof input.description === 'string'
        ? input.description.trim()
        : undefined,
    kind:
      input.kind === 'memory' ||
      input.kind === 'provider' ||
      input.kind === 'channel' ||
      input.kind === 'tool' ||
      input.kind === 'prompt-hook'
        ? input.kind
        : undefined,
    author: typeof input.author === 'string' ? input.author.trim() : undefined,
    entrypoint:
      typeof input.entrypoint === 'string'
        ? input.entrypoint.trim()
        : undefined,
    requires: isRecord(input.requires)
      ? {
          env: normalizeStringArray(input.requires.env),
          node:
            typeof input.requires.node === 'string'
              ? input.requires.node.trim()
              : undefined,
        }
      : undefined,
    install: Array.isArray(input.install)
      ? input.install.filter(isRecord).map((entry) => ({
          kind:
            entry.kind === 'npm' ||
            entry.kind === 'node' ||
            entry.kind === 'download'
              ? entry.kind
              : 'npm',
          package:
            typeof entry.package === 'string'
              ? entry.package.trim()
              : undefined,
          url: typeof entry.url === 'string' ? entry.url.trim() : undefined,
        }))
      : undefined,
    configSchema: isRecord(input.configSchema)
      ? (input.configSchema as PluginConfigSchema)
      : undefined,
    configUiHints: isRecord(input.configUiHints)
      ? Object.fromEntries(
          Object.entries(input.configUiHints)
            .filter(([, value]) => isRecord(value))
            .map(([key, value]) => {
              const hint = value as Record<string, unknown>;
              return [
                key,
                {
                  label:
                    typeof hint.label === 'string'
                      ? hint.label.trim()
                      : undefined,
                  placeholder:
                    typeof hint.placeholder === 'string'
                      ? hint.placeholder.trim()
                      : undefined,
                  help:
                    typeof hint.help === 'string'
                      ? hint.help.trim()
                      : undefined,
                },
              ];
            }),
        )
      : undefined,
  };
}

export function loadPluginManifest(manifestPath: string): PluginManifest {
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return normalizeManifest(parseYaml(raw) as unknown);
}

function resolvePluginEntrypoint(
  dir: string,
  manifest: PluginManifest,
): string {
  const candidates = [
    ...(manifest.entrypoint ? [manifest.entrypoint] : []),
    ...DEFAULT_ENTRYPOINT_CANDIDATES,
  ];

  for (const candidate of candidates) {
    const absolute = path.resolve(dir, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return absolute;
    }
  }

  throw new Error(
    `Plugin "${manifest.id}" has no entrypoint. Expected one of: ${candidates.join(', ')}`,
  );
}

function compareNumericTuple(left: number[], right: number[]): number {
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue === rightValue) continue;
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function satisfiesNodeRequirement(requirement?: string): boolean {
  const normalized = String(requirement || '').trim();
  if (!normalized) return true;
  const current = process.versions.node
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
  const gteMatch = normalized.match(/^>=\s*(\d+(?:\.\d+)*)$/);
  if (gteMatch) {
    const expected = gteMatch[1]
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .filter(Number.isFinite);
    return compareNumericTuple(current, expected) >= 0;
  }
  const exactMatch = normalized.match(/^(\d+(?:\.\d+)*)$/);
  if (exactMatch) {
    const expected = exactMatch[1]
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .filter(Number.isFinite);
    return compareNumericTuple(current, expected) >= 0;
  }
  return true;
}

function schemaTypeList(schema: PluginConfigSchema): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof schema.type === 'string' && schema.type.trim()) {
    return [schema.type.trim()];
  }
  return [];
}

function matchesSchemaType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateSchemaValue(
  schema: PluginConfigSchema,
  value: unknown,
  pointer: string,
): unknown {
  if (value === undefined && Object.hasOwn(schema, 'default')) {
    value = deepClone(schema.default);
  }

  const allowedTypes = schemaTypeList(schema);
  if (value !== undefined && allowedTypes.length > 0) {
    const matched = allowedTypes.some((type) => matchesSchemaType(type, value));
    if (!matched) {
      throw new Error(
        `${pointer} must be ${allowedTypes.join(' | ')}, received ${value === null ? 'null' : typeof value}.`,
      );
    }
  }

  if (value === undefined) return undefined;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const matches = schema.enum.some((entry) => entry === value);
    if (!matches) {
      throw new Error(`${pointer} must be one of ${schema.enum.join(', ')}.`);
    }
  }

  if (Array.isArray(value)) {
    if (!schema.items) return [...value];
    return value.map((entry, index) =>
      validateSchemaValue(
        schema.items as PluginConfigSchema,
        entry,
        `${pointer}[${index}]`,
      ),
    );
  }

  if (isRecord(value) || allowedTypes.includes('object')) {
    const source = isRecord(value) ? value : {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const output: Record<string, unknown> = {};
    const allowAdditional = schema.additionalProperties !== false;

    for (const [key, propertySchema] of Object.entries(properties)) {
      const normalized = validateSchemaValue(
        propertySchema,
        source[key],
        `${pointer}.${key}`,
      );
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }

    const required = normalizeStringArray(schema.required);
    for (const key of required) {
      if (Object.hasOwn(output, key)) continue;
      throw new Error(`${pointer}.${key} is required.`);
    }

    if (allowAdditional) {
      for (const [key, rawValue] of Object.entries(source)) {
        if (Object.hasOwn(properties, key)) continue;
        output[key] = deepClone(rawValue);
      }
    }

    return output;
  }

  return deepClone(value);
}

export function validatePluginConfig(
  schema: PluginConfigSchema | undefined,
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return deepClone(value || {});
  const normalized = validateSchemaValue(schema, value || {}, 'plugin config');
  if (!isRecord(normalized)) {
    throw new Error('Plugin config schema must resolve to an object.');
  }
  return normalized;
}

async function importPluginModule(entrypoint: string): Promise<unknown> {
  if (entrypoint.endsWith('.ts')) {
    const source = fs.readFileSync(entrypoint, 'utf-8');
    const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
    const compiledPath = path.join(
      path.dirname(entrypoint),
      `.${path.basename(entrypoint, '.ts')}.hybridclaw.mjs`,
    );
    fs.writeFileSync(
      compiledPath,
      `${stripped}\n//# sourceURL=${pathToFileURL(entrypoint).href}\n`,
      'utf-8',
    );
    return import(
      `${pathToFileURL(compiledPath).href}?t=${fs.statSync(compiledPath).mtimeMs}`
    );
  }
  return import(pathToFileURL(entrypoint).href);
}

function resolvePluginDefinition(mod: unknown): HybridClawPluginDefinition {
  const namespace = isRecord(mod) ? mod : {};
  const candidate = namespace.default ?? namespace.plugin ?? namespace;
  if (!isRecord(candidate)) {
    throw new Error('Plugin module did not export an object definition.');
  }
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    throw new Error('Plugin definition is missing `id`.');
  }
  if (typeof candidate.register !== 'function') {
    throw new Error(
      `Plugin "${candidate.id}" is missing a sync register(api) function.`,
    );
  }
  return candidate as unknown as HybridClawPluginDefinition;
}

function normalizeToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export class PluginManager {
  private readonly homeDir: string;
  private readonly cwd: string;
  private readonly getConfig: () => RuntimeConfig;
  private readonly logger: PluginLogger;
  private initializing: Promise<void> | null = null;
  private initialized = false;
  private gatewayStartedAt: string | null = null;
  private plugins: LoadedPlugin[] = [];
  private memoryLayers: RegisteredMemoryLayer[] = [];
  private promptHooks: RegisteredPromptHook[] = [];
  private tools = new Map<string, RegisteredTool>();
  private services: RegisteredService[] = [];
  private providers: RegisteredProvider[] = [];
  private channels: RegisteredChannel[] = [];
  private commands = new Map<string, RegisteredCommand>();
  private hooks = new Map<PluginHookName, RegisteredHook[]>();

  constructor(options?: PluginManagerOptions) {
    this.homeDir = options?.homeDir || os.homedir();
    this.cwd = options?.cwd || process.cwd();
    this.getConfig = options?.getRuntimeConfig || getRuntimeConfig;
    this.logger = options?.logger || rootLogger;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    this.initializing = this.initializeInternal();
    try {
      await this.initializing;
      this.initialized = true;
    } finally {
      this.initializing = null;
    }
  }

  private async initializeInternal(): Promise<void> {
    const runtimeConfig = this.getConfig();
    const candidates = await this.discoverPlugins(runtimeConfig);
    for (const candidate of candidates) {
      await this.loadPlugin(candidate, runtimeConfig);
    }

    await this.startMemoryLayers();
    await this.startServices();
    this.gatewayStartedAt = new Date().toISOString();
    await this.dispatchHook('gateway_start', {
      startedAt: this.gatewayStartedAt,
    });
  }

  async shutdown(): Promise<void> {
    if (!this.initialized && !this.initializing) return;
    if (this.initializing) {
      await this.initializing.catch(() => {});
    }
    const startedAt = this.gatewayStartedAt || new Date().toISOString();
    await this.dispatchHook('gateway_stop', { startedAt });

    for (const entry of [...this.memoryLayers].reverse()) {
      if (!entry.layer.stop) continue;
      try {
        await entry.layer.stop();
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, layerId: entry.layer.id, error },
          'Plugin memory layer shutdown failed',
        );
      }
    }

    for (const entry of [...this.services].reverse()) {
      if (!entry.service.stop) continue;
      try {
        await entry.service.stop();
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, serviceId: entry.service.id, error },
          'Plugin service shutdown failed',
        );
      }
    }
  }

  async discoverPlugins(
    config: RuntimeConfig = this.getConfig(),
  ): Promise<PluginCandidate[]> {
    const configuredEntries = toPluginConfigEntries(config);
    const discovered = new Map<string, PluginCandidate>();
    for (const candidate of this.scanDirectory(
      path.join(this.homeDir, '.hybridclaw', 'plugins'),
      'home',
    )) {
      if (!discovered.has(candidate.id))
        discovered.set(candidate.id, candidate);
    }
    for (const candidate of this.scanDirectory(
      path.join(this.cwd, '.hybridclaw', 'plugins'),
      'project',
    )) {
      if (!discovered.has(candidate.id))
        discovered.set(candidate.id, candidate);
    }

    const selected = new Map<string, PluginCandidate>(discovered);
    for (const entry of configuredEntries) {
      if (!entry.enabled) {
        selected.delete(entry.id);
        continue;
      }
      try {
        let candidate: PluginCandidate | undefined;
        if (entry.path) {
          candidate = this.scanPluginDir(
            path.resolve(this.cwd, entry.path),
            'config',
          );
          if (candidate.id !== entry.id) {
            throw new Error(
              `Configured plugin id "${entry.id}" did not match manifest id "${candidate.id}".`,
            );
          }
        } else {
          candidate = discovered.get(entry.id);
        }
        if (!candidate) {
          this.logger.warn(
            { pluginId: entry.id, sourcePath: entry.path || null },
            'Configured plugin was not found',
          );
          continue;
        }
        selected.set(entry.id, {
          ...candidate,
          enabled: true,
          config: deepClone(entry.config || {}),
        });
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.id, sourcePath: entry.path || null, error },
          'Failed to discover configured plugin',
        );
      }
    }
    return [...selected.values()];
  }

  private scanDirectory(
    dir: string,
    source: PluginCandidate['source'],
  ): PluginCandidate[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
    const out: PluginCandidate[] = [];
    for (const entry of entries) {
      try {
        out.push(this.scanPluginDir(entry, source));
      } catch (error) {
        this.logger.warn(
          { pluginDir: entry, source, error },
          'Skipping invalid plugin directory',
        );
      }
    }
    return out;
  }

  private scanPluginDir(
    dir: string,
    source: PluginCandidate['source'],
  ): PluginCandidate {
    const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing ${MANIFEST_FILE_NAME}`);
    }
    const manifest = loadPluginManifest(manifestPath);
    const entrypoint = resolvePluginEntrypoint(dir, manifest);
    return {
      id: manifest.id,
      dir,
      entrypoint,
      manifestPath,
      manifest,
      source,
      enabled: true,
      config: {},
    };
  }

  async loadPlugin(
    candidate: PluginCandidate,
    config: RuntimeConfig = this.getConfig(),
    registrationMode: PluginRegistrationMode = 'full',
  ): Promise<void> {
    if (!candidate.enabled) return;
    if (this.plugins.some((plugin) => plugin.id === candidate.id)) return;

    if (!satisfiesNodeRequirement(candidate.manifest.requires?.node)) {
      this.logger.warn(
        {
          pluginId: candidate.id,
          requiredNode: candidate.manifest.requires?.node,
          currentNode: process.versions.node,
        },
        'Skipping plugin due to unsupported Node.js requirement',
      );
      return;
    }

    const missingEnv = normalizeStringArray(
      candidate.manifest.requires?.env,
    ).filter((key) => {
      const value = process.env[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (missingEnv.length > 0) {
      const error = `Missing required env vars: ${missingEnv.join(', ')}.`;
      this.logger.warn(
        { pluginId: candidate.id, missingEnv },
        'Skipping plugin due to missing required environment variables',
      );
      this.plugins.push({
        id: candidate.id,
        manifest: candidate.manifest,
        candidate,
        enabled: false,
        status: 'failed',
        error,
        toolsRegistered: [],
        hooksRegistered: [],
      });
      return;
    }

    let definition: HybridClawPluginDefinition | undefined;
    let api: ReturnType<typeof createPluginApi> | undefined;
    let toolsRegistered: string[] = [];
    let hooksRegistered: string[] = [];

    try {
      const mod = await importPluginModule(candidate.entrypoint);
      definition = resolvePluginDefinition(mod);
      if (definition.id.trim() !== candidate.id) {
        throw new Error(
          `Plugin definition id "${definition.id}" did not match manifest id "${candidate.id}".`,
        );
      }
      const schema = definition.configSchema || candidate.manifest.configSchema;
      const validatedConfig = validatePluginConfig(schema, candidate.config);
      api = createPluginApi({
        manager: this,
        pluginId: definition.id,
        pluginDir: candidate.dir,
        registrationMode,
        config,
        pluginConfig: validatedConfig,
        homeDir: this.homeDir,
        cwd: this.cwd,
      });

      const snapshot = this.createPluginRegistrationSnapshot();
      try {
        const registerResult = definition.register(api) as unknown;
        if (
          registerResult &&
          typeof registerResult === 'object' &&
          typeof (registerResult as { then?: unknown }).then === 'function'
        ) {
          throw new Error(
            `Plugin "${definition.id}" returned a promise from register(api); register must be synchronous.`,
          );
        }
      } catch (error) {
        toolsRegistered = this.getPluginToolNames(definition.id);
        hooksRegistered = this.getPluginHookNames(definition.id);
        this.restorePluginRegistrationSnapshot(snapshot);
        throw error;
      }

      toolsRegistered = this.getPluginToolNames(definition.id);
      hooksRegistered = this.getPluginHookNames(definition.id);

      this.plugins.push({
        id: definition.id,
        manifest: candidate.manifest,
        definition,
        candidate,
        api,
        enabled: candidate.enabled,
        status: 'loaded',
        toolsRegistered,
        hooksRegistered,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error');
      const pluginId = definition?.id?.trim() || candidate.id;
      this.logger.warn(
        {
          pluginId,
          pluginDir: candidate.dir,
          entrypoint: candidate.entrypoint,
          errorMessage,
          error,
        },
        'Plugin failed to load',
      );
      this.plugins.push({
        id: pluginId,
        manifest: candidate.manifest,
        candidate,
        definition,
        api,
        enabled: candidate.enabled,
        status: 'failed',
        error: errorMessage,
        toolsRegistered,
        hooksRegistered,
      });
    }
  }

  registerMemoryLayer(pluginId: string, layer: MemoryLayerPlugin): void {
    if (this.memoryLayers.some((entry) => entry.layer.id === layer.id)) {
      throw new Error(`Memory layer "${layer.id}" is already registered.`);
    }
    this.memoryLayers.push({ pluginId, layer });
  }

  registerProvider(pluginId: string, provider: AIProvider): void {
    this.providers.push({ pluginId, provider });
  }

  registerChannel(pluginId: string, channel: ChannelInfo): void {
    registerChannel(channel);
    this.channels.push({ pluginId, channel });
  }

  registerTool(pluginId: string, tool: PluginToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Plugin tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, {
      pluginId,
      tool,
      logger: rootLogger.child({
        pluginId,
        toolName: tool.name,
      }) as PluginLogger,
    });
  }

  registerPromptHook(pluginId: string, hook: PluginPromptHook): void {
    this.promptHooks.push({ pluginId, hook });
  }

  registerCommand(pluginId: string, command: PluginCommandDefinition): void {
    if (this.commands.has(command.name)) {
      throw new Error(
        `Plugin command "${command.name}" is already registered.`,
      );
    }
    this.commands.set(command.name, { pluginId, command });
  }

  registerService(pluginId: string, service: PluginService): void {
    if (this.services.some((entry) => entry.service.id === service.id)) {
      throw new Error(`Plugin service "${service.id}" is already registered.`);
    }
    this.services.push({ pluginId, service });
  }

  registerHook<K extends PluginHookName>(
    pluginId: string,
    name: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ): void {
    const list = this.hooks.get(name) || [];
    list.push({
      pluginId,
      priority: opts?.priority ?? 0,
      handler,
    });
    list.sort((left, right) => left.priority - right.priority);
    this.hooks.set(name, list);
  }

  getLoadedPlugins(): LoadedPlugin[] {
    return [...this.plugins];
  }

  listPluginSummary(): PluginSummary[] {
    return this.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      source: plugin.candidate.source,
      enabled: plugin.enabled,
      error: plugin.error,
      tools: [...plugin.toolsRegistered],
      hooks: [...plugin.hooksRegistered],
    }));
  }

  private createPluginRegistrationSnapshot(): PluginRegistrationSnapshot {
    return {
      memoryLayers: [...this.memoryLayers],
      promptHooks: [...this.promptHooks],
      services: [...this.services],
      providers: [...this.providers],
      channels: [...this.channels],
      tools: new Map(this.tools),
      commands: new Map(this.commands),
      hooks: new Map(
        [...this.hooks.entries()].map(([name, entries]) => [name, [...entries]]),
      ),
      registeredChannels: listChannels(),
    };
  }

  private restorePluginRegistrationSnapshot(
    snapshot: PluginRegistrationSnapshot,
  ): void {
    this.memoryLayers = [...snapshot.memoryLayers];
    this.promptHooks = [...snapshot.promptHooks];
    this.services = [...snapshot.services];
    this.providers = [...snapshot.providers];
    this.channels = [...snapshot.channels];
    this.tools = new Map(snapshot.tools);
    this.commands = new Map(snapshot.commands);
    this.hooks = new Map(
      [...snapshot.hooks.entries()].map(([name, entries]) => [name, [...entries]]),
    );

    for (const channel of listChannels()) {
      unregisterChannel(channel.kind);
    }
    for (const channel of snapshot.registeredChannels) {
      registerChannel(channel);
    }
  }

  private getPluginToolNames(pluginId: string): string[] {
    return Array.from(this.tools.values())
      .filter((entry) => entry.pluginId === pluginId)
      .map((entry) => entry.tool.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private getPluginHookNames(pluginId: string): string[] {
    const registered = new Set<string>();

    for (const entry of this.promptHooks) {
      if (entry.pluginId !== pluginId) continue;
      registered.add(entry.hook.id);
    }

    for (const [name, entries] of this.hooks.entries()) {
      if (entries.some((entry) => entry.pluginId === pluginId)) {
        registered.add(name);
      }
    }

    return [...registered].sort((left, right) => left.localeCompare(right));
  }

  getMemoryLayers(): MemoryLayerPlugin[] {
    return [...this.memoryLayers]
      .sort((left, right) => left.layer.priority - right.layer.priority)
      .map((entry) => entry.layer);
  }

  getToolDefinitions(): PluginRuntimeToolDefinition[] {
    return Array.from(this.tools.values())
      .map((entry) => ({
        name: entry.tool.name,
        description: entry.tool.description,
        parameters: deepClone(entry.tool.parameters as PluginToolSchema),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getProviders(): AIProvider[] {
    return this.providers.map((entry) => entry.provider);
  }

  getChannels(): ChannelInfo[] {
    return this.channels.map((entry) => entry.channel);
  }

  findCommand(name: string): PluginCommandDefinition | undefined {
    return this.commands.get(name)?.command;
  }

  async collectPromptContext(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    recentMessages: StoredMessage[];
  }): Promise<string[]> {
    await this.ensureInitialized();

    const extraContext: string[] = [];
    for (const entry of [...this.memoryLayers].sort(
      (left, right) => left.layer.priority - right.layer.priority,
    )) {
      if (!entry.layer.getContextForPrompt) continue;
      try {
        const value = await entry.layer.getContextForPrompt({
          sessionId: params.sessionId,
          userId: params.userId,
          agentId: params.agentId,
          recentMessages: params.recentMessages,
        });
        if (typeof value === 'string' && value.trim()) {
          extraContext.push(value.trim());
        }
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, layerId: entry.layer.id, error },
          'Plugin memory-layer prompt recall failed',
        );
      }
    }

    const hookContext: PluginPromptBuildContext = {
      ...params,
      extraContext,
    };
    for (const entry of [...this.promptHooks].sort(
      (left, right) => (left.hook.priority ?? 0) - (right.hook.priority ?? 0),
    )) {
      try {
        const value = await entry.hook.render(hookContext);
        if (typeof value === 'string' && value.trim()) {
          extraContext.push(value.trim());
        }
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, promptHookId: entry.hook.id, error },
          'Plugin prompt hook failed',
        );
      }
    }

    await this.dispatchHook('before_prompt_build', hookContext);
    return extraContext.filter(
      (value, index, list) => list.indexOf(value) === index,
    );
  }

  async notifySessionStart(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
  }): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('session_start', params);
  }

  async notifySessionEnd(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
  }): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('session_end', params);
  }

  async notifyBeforeAgentStart(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
  }): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('before_agent_start', params);
  }

  async notifyAgentEnd(context: PluginAgentEndContext): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('agent_end', context);
  }

  async notifyTurnComplete(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    messages: StoredMessage[];
  }): Promise<void> {
    await this.ensureInitialized();
    for (const entry of this.getOrderedMemoryLayerEntries()) {
      if (!entry.layer.onTurnComplete) continue;
      try {
        await entry.layer.onTurnComplete(params);
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, layerId: entry.layer.id, error },
          'Plugin memory-layer capture failed',
        );
      }
    }
  }

  async handleSessionReset(context: PluginSessionResetContext): Promise<void> {
    await this.ensureInitialized();
    for (const entry of this.getOrderedMemoryLayerEntries()) {
      if (!entry.layer.onSessionReset) continue;
      try {
        await entry.layer.onSessionReset({
          sessionId: context.sessionId,
          userId: context.userId,
        });
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, layerId: entry.layer.id, error },
          'Plugin memory-layer reset hook failed',
        );
      }
    }
    await this.dispatchHook('session_reset', context);
  }

  async notifyBeforeCompaction(
    context: PluginCompactionContext,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('before_compaction', context);
  }

  async notifyAfterCompaction(context: PluginCompactionContext): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('after_compaction', context);
  }

  async notifyMemoryFlush(context: PluginMemoryFlushContext): Promise<void> {
    await this.ensureInitialized();
    await this.dispatchHook('memory_flush', context);
  }

  async executeTool(params: ExecutePluginToolParams): Promise<string> {
    await this.ensureInitialized();
    const entry = this.tools.get(params.toolName);
    if (!entry) {
      throw new Error(`Plugin tool "${params.toolName}" is not registered.`);
    }

    const toolArgs = isRecord(params.args) ? params.args : {};
    await this.dispatchHook('before_tool_call', {
      sessionId: params.sessionId,
      channelId: params.channelId,
      toolName: params.toolName,
      arguments: toolArgs,
    });

    const context: PluginToolHandlerContext = {
      sessionId: params.sessionId,
      channelId: params.channelId,
      pluginId: entry.pluginId,
      logger: entry.logger,
    };
    try {
      const result = normalizeToolResult(
        await entry.tool.handler(toolArgs, context),
      );
      await this.dispatchHook('after_tool_call', {
        sessionId: params.sessionId,
        channelId: params.channelId,
        toolName: params.toolName,
        arguments: toolArgs,
        result,
        isError: false,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error');
      await this.dispatchHook('after_tool_call', {
        sessionId: params.sessionId,
        channelId: params.channelId,
        toolName: params.toolName,
        arguments: toolArgs,
        result: message,
        isError: true,
      });
      throw error;
    }
  }

  private getOrderedMemoryLayerEntries(): RegisteredMemoryLayer[] {
    return [...this.memoryLayers].sort(
      (left, right) => left.layer.priority - right.layer.priority,
    );
  }

  private async startMemoryLayers(): Promise<void> {
    for (const entry of this.getOrderedMemoryLayerEntries()) {
      if (!entry.layer.start) continue;
      try {
        await entry.layer.start();
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, layerId: entry.layer.id, error },
          'Plugin memory layer failed to start',
        );
      }
    }
  }

  private async startServices(): Promise<void> {
    for (const entry of this.services) {
      if (!entry.service.start) continue;
      try {
        await entry.service.start();
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, serviceId: entry.service.id, error },
          'Plugin service failed to start',
        );
      }
    }
  }

  private async dispatchHook<K extends PluginHookName>(
    name: K,
    payload: Parameters<PluginHookHandlerMap[K]>[0],
  ): Promise<void> {
    const handlers = this.hooks.get(name);
    if (!handlers || handlers.length === 0) return;
    for (const entry of handlers as RegisteredHook<K>[]) {
      try {
        await (
          entry.handler as (
            value: Parameters<PluginHookHandlerMap[K]>[0],
          ) => Promise<void> | void
        )(payload);
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, hookName: name, error },
          'Plugin lifecycle hook failed',
        );
      }
    }
  }
}

let singleton: PluginManager | null = null;

export function getPluginManager(): PluginManager {
  singleton ??= new PluginManager({
    homeDir: os.homedir(),
    cwd: process.cwd(),
    getRuntimeConfig,
  });
  return singleton;
}

export async function ensurePluginManagerInitialized(): Promise<PluginManager> {
  const manager = getPluginManager();
  await manager.ensureInitialized();
  return manager;
}

export async function shutdownPluginManager(): Promise<void> {
  if (!singleton) return;
  await singleton.shutdown();
}
