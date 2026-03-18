import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv, type AnySchemaObject, type ErrorObject } from 'ajv';
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
  PluginConfigUiHint,
  PluginHookHandlerMap,
  PluginHookName,
  PluginInstallSpec,
  PluginLogger,
  PluginManifest,
  PluginMemoryFlushContext,
  PluginPromptBuildContext,
  PluginPromptHook,
  PluginRegistrationMode,
  PluginRuntimeToolDefinition,
  PluginService,
  PluginSessionResetContext,
  PluginSummary,
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

const pluginConfigValidator = new Ajv({
  allErrors: false,
  removeAdditional: true,
  strictSchema: true,
  strictTypes: false,
  useDefaults: true,
});

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
  plugins: LoadedPlugin[];
  memoryLayers: RegisteredMemoryLayer[];
  promptHooks: RegisteredPromptHook[];
  services: RegisteredService[];
  providers: RegisteredProvider[];
  channels: RegisteredChannel[];
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  hooks: Map<PluginHookName, RegisteredHook[]>;
  registeredChannels: ChannelInfo[];
  gatewayStartedAt: string | null;
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

function safeString(value: () => unknown, fallback: string): string {
  try {
    const resolved = value();
    return typeof resolved === 'string' && resolved.trim().length > 0
      ? resolved
      : fallback;
  } catch {
    return fallback;
  }
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

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizePluginKind(value: unknown): PluginManifest['kind'] {
  return value === 'memory' ||
    value === 'provider' ||
    value === 'channel' ||
    value === 'tool' ||
    value === 'prompt-hook'
    ? value
    : undefined;
}

function normalizePluginInstallKind(value: unknown): PluginInstallSpec['kind'] {
  return value === 'npm' || value === 'node' || value === 'download'
    ? value
    : 'npm';
}

function normalizePluginInstallSpecs(
  value: unknown,
): PluginInstallSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((entry) => ({
    kind: normalizePluginInstallKind(entry.kind),
    package: normalizeTrimmedString(entry.package),
    url: normalizeTrimmedString(entry.url),
  }));
}

function normalizePluginConfigUiHints(
  value: unknown,
): Record<string, PluginConfigUiHint> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => isRecord(entry))
      .map(([key, entry]) => {
        const hint = entry as Record<string, unknown>;
        return [
          key,
          {
            label: normalizeTrimmedString(hint.label),
            placeholder: normalizeTrimmedString(hint.placeholder),
            help: normalizeTrimmedString(hint.help),
          },
        ];
      }),
  );
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

  const id = normalizeTrimmedString(input.id);
  if (!id) {
    throw new Error('Plugin manifest is missing `id`.');
  }

  return {
    id,
    name: normalizeTrimmedString(input.name),
    version: normalizeTrimmedString(input.version),
    description: normalizeTrimmedString(input.description),
    kind: normalizePluginKind(input.kind),
    author: normalizeTrimmedString(input.author),
    entrypoint: normalizeTrimmedString(input.entrypoint),
    requires: isRecord(input.requires)
      ? {
          env: normalizeStringArray(input.requires.env),
          node: normalizeTrimmedString(input.requires.node),
        }
      : undefined,
    install: normalizePluginInstallSpecs(input.install),
    configSchema: isRecord(input.configSchema)
      ? (input.configSchema as PluginConfigSchema)
      : undefined,
    configUiHints: normalizePluginConfigUiHints(input.configUiHints),
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

function matchesNumericTuplePrefix(
  current: number[],
  expected: number[],
): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if ((current[index] ?? 0) !== expected[index]) {
      return false;
    }
  }
  return true;
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
    return matchesNumericTuplePrefix(current, expected);
  }
  return true;
}

function decodeJsonPointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function formatAjvInstancePath(instancePath: string): string {
  if (!instancePath) return 'plugin config';
  const segments = instancePath
    .split('/')
    .slice(1)
    .map(decodeJsonPointerSegment);
  let output = 'plugin config';
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      output += `[${segment}]`;
      continue;
    }
    output += `.${segment}`;
  }
  return output;
}

function formatAjvValidationError(error: ErrorObject): string {
  const pointer = formatAjvInstancePath(error.instancePath);
  if (error.keyword === 'required') {
    const missingProperty = isRecord(error.params)
      ? normalizeTrimmedString(error.params.missingProperty)
      : undefined;
    if (missingProperty) {
      return `${pointer}.${missingProperty} is required.`;
    }
  }
  if (error.keyword === 'enum' && Array.isArray(error.schema)) {
    return `${pointer} must be one of ${error.schema.join(', ')}.`;
  }
  if (error.keyword === 'additionalProperties') {
    const additionalProperty = isRecord(error.params)
      ? normalizeTrimmedString(error.params.additionalProperty)
      : undefined;
    if (additionalProperty) {
      return `${pointer}.${additionalProperty} is not allowed.`;
    }
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}

export function validatePluginConfig(
  schema: PluginConfigSchema | undefined,
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return structuredClone(value || {});
  let validate: ReturnType<typeof pluginConfigValidator.compile>;
  try {
    validate = pluginConfigValidator.compile(schema as AnySchemaObject);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || 'Unknown error');
    throw new Error(`Invalid plugin config schema: ${message}`);
  }

  const normalized = structuredClone(value || {});
  if (!validate(normalized)) {
    const [firstError] = validate.errors || [];
    if (firstError) {
      throw new Error(formatAjvValidationError(firstError));
    }
    throw new Error('Plugin config is invalid.');
  }

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
    try {
      return await import(
        `${pathToFileURL(compiledPath).href}?t=${fs.statSync(compiledPath).mtimeMs}`
      );
    } finally {
      try {
        fs.rmSync(compiledPath, { force: true });
      } catch (error) {
        rootLogger.warn(
          {
            entrypoint,
            compiledPath,
            error,
          },
          'Failed to clean up temporary compiled plugin module',
        );
      }
    }
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
    const snapshot = this.createPluginRegistrationSnapshot();
    this.initializing = this.initializeInternal();
    try {
      await this.initializing;
      this.initialized = true;
    } catch (error) {
      this.restorePluginRegistrationSnapshot(snapshot);
      throw error;
    } finally {
      this.initializing = null;
    }
  }

  private async initializeInternal(): Promise<void> {
    const runtimeConfig = this.getConfig();
    const candidates = await this.discoverPlugins(runtimeConfig);
    for (const candidate of candidates) {
      try {
        await this.loadPlugin(candidate, runtimeConfig);
      } catch (error) {
        this.recordPluginLoadFailure({ candidate, error });
      }
    }

    try {
      await this.startMemoryLayers();
    } catch (error) {
      this.logger.warn({ error }, 'Plugin memory layer startup phase crashed');
    }
    try {
      await this.startServices();
    } catch (error) {
      this.logger.warn({ error }, 'Plugin service startup phase crashed');
    }
    this.gatewayStartedAt = new Date().toISOString();
    try {
      await this.dispatchHook('gateway_start', {
        startedAt: this.gatewayStartedAt,
      });
    } catch (error) {
      this.logger.warn({ error }, 'Plugin gateway-start hook phase crashed');
    }
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
          config: structuredClone(entry.config || {}),
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
        declaredEnv: candidate.manifest.requires?.env || [],
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
      this.recordPluginLoadFailure({
        candidate,
        error,
        definition,
        api,
        toolsRegistered,
        hooksRegistered,
      });
    }
  }

  private recordPluginLoadFailure(params: {
    candidate: PluginCandidate;
    error: unknown;
    definition?: HybridClawPluginDefinition;
    api?: LoadedPlugin['api'];
    toolsRegistered?: string[];
    hooksRegistered?: string[];
  }): void {
    const errorMessage =
      params.error instanceof Error
        ? params.error.message
        : String(params.error || 'Unknown error');
    const pluginId = params.definition?.id?.trim() || params.candidate.id;
    this.logger.warn(
      {
        pluginId,
        pluginDir: params.candidate.dir,
        entrypoint: params.candidate.entrypoint,
        errorMessage,
        error: params.error,
      },
      'Plugin failed to load',
    );
    if (this.plugins.some((plugin) => plugin.id === pluginId)) return;
    this.plugins.push({
      id: pluginId,
      manifest: params.candidate.manifest,
      candidate: params.candidate,
      definition: params.definition,
      api: params.api,
      enabled: params.candidate.enabled,
      status: 'failed',
      error: errorMessage,
      toolsRegistered: [...(params.toolsRegistered || [])],
      hooksRegistered: [...(params.hooksRegistered || [])],
    });
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
      plugins: [...this.plugins],
      memoryLayers: [...this.memoryLayers],
      promptHooks: [...this.promptHooks],
      services: [...this.services],
      providers: [...this.providers],
      channels: [...this.channels],
      tools: new Map(this.tools),
      commands: new Map(this.commands),
      hooks: new Map(
        [...this.hooks.entries()].map(([name, entries]) => [
          name,
          [...entries],
        ]),
      ),
      registeredChannels: listChannels(),
      gatewayStartedAt: this.gatewayStartedAt,
    };
  }

  private restorePluginRegistrationSnapshot(
    snapshot: PluginRegistrationSnapshot,
  ): void {
    this.plugins = [...snapshot.plugins];
    this.memoryLayers = [...snapshot.memoryLayers];
    this.promptHooks = [...snapshot.promptHooks];
    this.services = [...snapshot.services];
    this.providers = [...snapshot.providers];
    this.channels = [...snapshot.channels];
    this.tools = new Map(snapshot.tools);
    this.commands = new Map(snapshot.commands);
    this.hooks = new Map(
      [...snapshot.hooks.entries()].map(([name, entries]) => [
        name,
        [...entries],
      ]),
    );
    this.gatewayStartedAt = snapshot.gatewayStartedAt;

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
        parameters: structuredClone(entry.tool.parameters as PluginToolSchema),
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
    model?: string;
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
      try {
        const start = entry.layer.start;
        if (!start) continue;
        await start.call(entry.layer);
      } catch (error) {
        this.logger.warn(
          {
            pluginId: entry.pluginId,
            layerId: safeString(() => entry.layer.id, '(unknown)'),
            error,
          },
          'Plugin memory layer failed to start',
        );
      }
    }
  }

  private async startServices(): Promise<void> {
    for (const entry of this.services) {
      try {
        const start = entry.service.start;
        if (!start) continue;
        await start.call(entry.service);
      } catch (error) {
        this.logger.warn(
          {
            pluginId: entry.pluginId,
            serviceId: safeString(() => entry.service.id, '(unknown)'),
            error,
          },
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
  try {
    await manager.ensureInitialized();
    return manager;
  } catch (error) {
    if (singleton === manager) {
      singleton = null;
    }
    throw error;
  }
}

export async function shutdownPluginManager(): Promise<void> {
  if (!singleton) return;
  const manager = singleton;
  singleton = null;
  await manager.shutdown();
}

export async function reloadPluginManager(): Promise<PluginManager> {
  await shutdownPluginManager();
  return ensurePluginManagerInitialized();
}
