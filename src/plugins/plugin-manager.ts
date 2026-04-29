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
import { sendWebhookJson, WebhookHttpError } from '../channels/webhook-http.js';
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger as rootLogger } from '../logger.js';
import type { AIProvider } from '../providers/types.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import type { ToolExecution } from '../types/execution.js';
import type { McpServerConfig } from '../types/models.js';
import type { StoredMessage } from '../types/session.js';
import { hasExecutableCommand } from '../utils/executables.js';
import { createPluginApi } from './plugin-api.js';
import type {
  HybridClawPluginDefinition,
  LoadedPlugin,
  MemoryLayerPlugin,
  PluginAgentEndContext,
  PluginBinaryRequirement,
  PluginCandidate,
  PluginCommandDefinition,
  PluginCompactionContext,
  PluginConfigSchema,
  PluginConfigUiHint,
  PluginDispatchInboundMessageRequest,
  PluginExternalDependency,
  PluginHookHandlerMap,
  PluginHookName,
  PluginInboundWebhookContext,
  PluginInboundWebhookDefinition,
  PluginInstallSpec,
  PluginLogger,
  PluginManifest,
  PluginMemoryBehavior,
  PluginMemoryFlushContext,
  PluginMemoryWriteAction,
  PluginMemoryWriteContext,
  PluginOutputGuard,
  PluginOutputGuardContext,
  PluginOutputGuardDecision,
  PluginOutputGuardEvent,
  PluginOutputGuardOutcome,
  PluginPackageDependency,
  PluginPromptBuildContext,
  PluginPromptContextResult,
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
import { buildPluginInboundWebhookPath } from './plugin-webhooks.js';

const MANIFEST_FILE_NAME = 'hybridclaw.plugin.yaml';
const DEFAULT_ENTRYPOINT_CANDIDATES = [
  'index.js',
  'index.mjs',
  'index.cjs',
  path.join('dist', 'index.js'),
  'index.ts',
];

const PLUGIN_MEMORY_ROOT_FILES = new Set(['MEMORY.md', 'USER.md']);
const PLUGIN_DAILY_MEMORY_FILE_RE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;

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

function comparePluginCandidates(
  left: PluginCandidate,
  right: PluginCandidate,
  configuredIds: ReadonlySet<string>,
): number {
  const leftConfigured = configuredIds.has(left.id);
  const rightConfigured = configuredIds.has(right.id);
  if (leftConfigured !== rightConfigured) {
    return leftConfigured ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

type RegisteredMemoryLayer = {
  pluginId: string;
  layer: MemoryLayerPlugin;
};

type RegisteredPromptHook = {
  pluginId: string;
  hook: PluginPromptHook;
};

type RegisteredOutputGuard = {
  pluginId: string;
  guard: PluginOutputGuard;
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

type RegisteredInboundWebhook = {
  pluginId: string;
  path: string;
  webhook: PluginInboundWebhookDefinition & {
    method: 'GET' | 'POST';
    name: string;
  };
  logger: PluginLogger;
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

export interface PluginCommandSummary {
  name: string;
  description?: string;
}

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
  outputGuards: RegisteredOutputGuard[];
  services: RegisteredService[];
  inboundWebhooks: Map<string, RegisteredInboundWebhook>;
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
  dispatchInboundMessage?: (
    pluginId: string,
    request: PluginDispatchInboundMessageRequest,
  ) => Promise<import('../gateway/gateway-types.js').GatewayChatResult>;
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

function parseJsonObject(value: string): Record<string, unknown> | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMemoryWriteAction(
  value: unknown,
): PluginMemoryWriteAction | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'append' ||
    normalized === 'write' ||
    normalized === 'replace' ||
    normalized === 'remove'
    ? normalized
    : null;
}

function normalizeMemoryFilePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') return null;
  const normalized = rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
  if (!normalized) return null;
  if (PLUGIN_MEMORY_ROOT_FILES.has(normalized)) return normalized;
  if (PLUGIN_DAILY_MEMORY_FILE_RE.test(normalized)) return normalized;
  return null;
}

function memoryFilePathFromResult(result: string): string | null {
  const normalized = result.trim();
  if (!normalized) return null;
  const directMatch =
    /^Appended \d+ chars to (.+)$/u.exec(normalized) ||
    /^Wrote \d+ chars to (.+)$/u.exec(normalized) ||
    /^Updated (.+)$/u.exec(normalized) ||
    /^Removed matching text from (.+)$/u.exec(normalized);
  return directMatch ? normalizeMemoryFilePath(directMatch[1]) : null;
}

function resolveMemoryWriteFilePath(
  args: Record<string, unknown>,
  result: string,
): string | null {
  const direct =
    normalizeMemoryFilePath(args.file_path) ||
    normalizeMemoryFilePath(args.path);
  if (direct) return direct;

  const target =
    typeof args.target === 'string' ? args.target.trim().toLowerCase() : '';
  if (target === 'memory') return 'MEMORY.md';
  if (target === 'user') return 'USER.md';
  if (target === 'daily' && typeof args.date === 'string') {
    return normalizeMemoryFilePath(`memory/${args.date.trim()}.md`);
  }

  return memoryFilePathFromResult(result);
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

function normalizePluginPackageDependencies(
  value: unknown,
): PluginPackageDependency[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PluginPackageDependency[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const pkg = normalizeTrimmedString(entry);
      if (!pkg) continue;
      out.push({ package: pkg });
      continue;
    }
    if (!isRecord(entry)) continue;
    const pkg = normalizeTrimmedString(entry.package);
    if (!pkg) continue;
    out.push({ package: pkg });
  }
  return out.length > 0 ? out : undefined;
}

function normalizePluginExternalDependencies(
  value: unknown,
): PluginExternalDependency[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PluginExternalDependency[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = normalizeTrimmedString(entry.name);
    const check = normalizeTrimmedString(entry.check);
    if (!name || !check) continue;
    const installHint =
      normalizeTrimmedString(entry.installHint) ||
      normalizeTrimmedString(entry.install);
    const installUrl = normalizeTrimmedString(entry.installUrl);
    out.push({
      name,
      check,
      ...(installHint ? { installHint } : {}),
      ...(installUrl ? { installUrl } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizePluginBinaryRequirements(
  value: unknown,
): PluginBinaryRequirement[] {
  if (!Array.isArray(value)) return [];
  const out: PluginBinaryRequirement[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const name = normalizeTrimmedString(entry);
      if (!name) continue;
      out.push({ name });
      continue;
    }
    if (!isRecord(entry)) continue;
    const name = normalizeTrimmedString(entry.name);
    if (!name) continue;
    const configKey = normalizeTrimmedString(entry.configKey);
    const installHint = normalizeTrimmedString(entry.installHint);
    const installUrl = normalizeTrimmedString(entry.installUrl);
    out.push({
      name,
      ...(configKey ? { configKey } : {}),
      ...(installHint ? { installHint } : {}),
      ...(installUrl ? { installUrl } : {}),
    });
  }
  return out;
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
  const credentials = normalizeStringArray(input.credentials);

  return {
    id,
    name: normalizeTrimmedString(input.name),
    version: normalizeTrimmedString(input.version),
    description: normalizeTrimmedString(input.description),
    kind: normalizePluginKind(input.kind),
    memoryProvider: input.memoryProvider === true ? true : undefined,
    author: normalizeTrimmedString(input.author),
    entrypoint: normalizeTrimmedString(input.entrypoint),
    requires: isRecord(input.requires)
      ? {
          bins: normalizePluginBinaryRequirements(input.requires.bins),
          env: normalizeStringArray(input.requires.env),
          node: normalizeTrimmedString(input.requires.node),
        }
      : undefined,
    credentials: credentials.length > 0 ? credentials : undefined,
    install: normalizePluginInstallSpecs(input.install),
    pipDependencies: normalizePluginPackageDependencies(
      input.pipDependencies ?? input.pip_dependencies,
    ),
    nodeDependencies: normalizePluginPackageDependencies(
      input.nodeDependencies ?? input.node_dependencies,
    ),
    externalDependencies: normalizePluginExternalDependencies(
      input.externalDependencies ?? input.external_dependencies,
    ),
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

function resolveRequiredBinaryCommand(
  requirement: PluginBinaryRequirement,
  config: Record<string, unknown>,
): string {
  if (requirement.configKey) {
    const configured = normalizeTrimmedString(config[requirement.configKey]);
    if (configured) return configured;
  }
  return requirement.name;
}

function formatMissingBinaryRequirement(params: {
  requirement: PluginBinaryRequirement;
  command: string;
}): string {
  if (
    params.requirement.configKey &&
    params.command.trim() !== params.requirement.name
  ) {
    return `${params.requirement.name} (from ${params.requirement.configKey}=${params.command})`;
  }
  return params.requirement.name;
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

function createPluginImportSnapshot(pluginDir: string): {
  rootDir: string;
  snapshotDir: string;
} {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-plugin-import-'),
  );
  const snapshotDir = path.join(rootDir, 'plugin');
  fs.cpSync(pluginDir, snapshotDir, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      if (baseName === 'node_modules') return false;
      if (sourcePath.endsWith('.hybridclaw.mjs')) return false;
      return true;
    },
  });

  const sourceNodeModules = path.join(pluginDir, 'node_modules');
  if (fs.existsSync(sourceNodeModules)) {
    fs.symlinkSync(
      sourceNodeModules,
      path.join(snapshotDir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  return { rootDir, snapshotDir };
}

function cleanupPluginImportSnapshot(rootDir: string): void {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch (error) {
    rootLogger.warn(
      { rootDir, error },
      'Failed to clean up temporary plugin import snapshot',
    );
  }
}

async function importPluginModule(
  entrypoint: string,
  pluginDir: string,
): Promise<{ module: unknown; snapshotRootDir: string }> {
  const { rootDir, snapshotDir } = createPluginImportSnapshot(pluginDir);
  const snapshotEntrypoint = path.join(
    snapshotDir,
    path.relative(pluginDir, entrypoint),
  );

  try {
    if (entrypoint.endsWith('.ts')) {
      const source = fs.readFileSync(snapshotEntrypoint, 'utf-8');
      const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
      const compiledPath = path.join(
        path.dirname(snapshotEntrypoint),
        `.${path.basename(snapshotEntrypoint, '.ts')}.hybridclaw.mjs`,
      );
      fs.writeFileSync(
        compiledPath,
        `${stripped}\n//# sourceURL=${pathToFileURL(entrypoint).href}\n`,
        'utf-8',
      );
      return {
        module: await import(pathToFileURL(compiledPath).href),
        snapshotRootDir: rootDir,
      };
    }

    return {
      module: await import(pathToFileURL(snapshotEntrypoint).href),
      snapshotRootDir: rootDir,
    };
  } catch (error) {
    cleanupPluginImportSnapshot(rootDir);
    throw error;
  }
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

export async function resolveEffectivePluginConfigSchema(
  candidate: PluginCandidate,
): Promise<PluginConfigSchema | undefined> {
  let importedModule: { module: unknown; snapshotRootDir: string } | null =
    null;
  try {
    importedModule = await importPluginModule(
      candidate.entrypoint,
      candidate.dir,
    );
    const definition = resolvePluginDefinition(importedModule.module);
    if (definition.id.trim() !== candidate.id) {
      return candidate.manifest.configSchema;
    }
    return definition.configSchema || candidate.manifest.configSchema;
  } catch {
    return candidate.manifest.configSchema;
  } finally {
    if (importedModule?.snapshotRootDir) {
      cleanupPluginImportSnapshot(importedModule.snapshotRootDir);
    }
  }
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
  private outputGuards: RegisteredOutputGuard[] = [];
  private tools = new Map<string, RegisteredTool>();
  private services: RegisteredService[] = [];
  private inboundWebhooks = new Map<string, RegisteredInboundWebhook>();
  private providers: RegisteredProvider[] = [];
  private channels: RegisteredChannel[] = [];
  private commands = new Map<string, RegisteredCommand>();
  private hooks = new Map<PluginHookName, RegisteredHook[]>();
  private sessionWorkspaceRoots = new Map<string, string>();
  private sessionUserIds = new Map<string, string>();
  private importSnapshotRoots: string[] = [];
  private dispatchInboundMessageHost:
    | ((
        pluginId: string,
        request: PluginDispatchInboundMessageRequest,
      ) => Promise<import('../gateway/gateway-types.js').GatewayChatResult>)
    | null;

  constructor(options?: PluginManagerOptions) {
    this.homeDir = options?.homeDir || DEFAULT_RUNTIME_HOME_DIR;
    this.cwd = options?.cwd || process.cwd();
    this.getConfig = options?.getRuntimeConfig || getRuntimeConfig;
    this.logger = options?.logger || rootLogger;
    this.dispatchInboundMessageHost = options?.dispatchInboundMessage || null;
  }

  setDispatchInboundMessageHost(
    dispatcher:
      | ((
          pluginId: string,
          request: PluginDispatchInboundMessageRequest,
        ) => Promise<import('../gateway/gateway-types.js').GatewayChatResult>)
      | null,
  ): void {
    this.dispatchInboundMessageHost = dispatcher;
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
      this.cleanupImportSnapshots();
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

    this.cleanupImportSnapshots();
  }

  private cleanupImportSnapshots(): void {
    for (const rootDir of this.importSnapshotRoots.splice(0)) {
      cleanupPluginImportSnapshot(rootDir);
    }
  }

  async discoverPlugins(
    config: RuntimeConfig = this.getConfig(),
  ): Promise<PluginCandidate[]> {
    const configuredEntries = toPluginConfigEntries(config);
    const configuredIds = new Set(
      configuredEntries
        .filter((entry) => entry.enabled)
        .map((entry) => String(entry.id || '').trim())
        .filter((entry) => entry.length > 0),
    );
    const discovered = new Map<string, PluginCandidate>();
    for (const candidate of this.scanDirectory(
      path.join(this.homeDir, 'plugins'),
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
    return [...selected.values()].sort((left, right) =>
      comparePluginCandidates(left, right, configuredIds),
    );
  }

  private scanDirectory(
    dir: string,
    source: PluginCandidate['source'],
  ): PluginCandidate[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
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
    if (candidate.manifest.memoryProvider) {
      const activeMemoryProvider = this.plugins.find(
        (plugin) =>
          plugin.status === 'loaded' && plugin.manifest.memoryProvider === true,
      );
      if (activeMemoryProvider) {
        const error = [
          'Only one external memory provider can be active at a time.',
          `"${activeMemoryProvider.id}" is already loaded.`,
        ].join(' ');
        this.logger.warn(
          {
            pluginId: candidate.id,
            activeMemoryProvider: activeMemoryProvider.id,
          },
          'Skipping plugin because another external memory provider is already active',
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
    }

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
      if (typeof value === 'string' && value.trim().length > 0) {
        return false;
      }
      const stored = readStoredRuntimeSecret(key);
      return typeof stored !== 'string' || stored.trim().length === 0;
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

    const missingBins = (candidate.manifest.requires?.bins || [])
      .map((requirement) => ({
        requirement,
        command: resolveRequiredBinaryCommand(requirement, candidate.config),
      }))
      .filter(
        ({ command }) => !hasExecutableCommand(command, { cwd: this.cwd }),
      );
    if (missingBins.length > 0) {
      const missingLabels = missingBins.map((entry) =>
        formatMissingBinaryRequirement(entry),
      );
      const error = `Missing required binaries: ${missingLabels.join(', ')}.`;
      this.logger.warn(
        {
          pluginId: candidate.id,
          missingBins: missingBins.map((entry) => ({
            name: entry.requirement.name,
            configKey: entry.requirement.configKey,
            command: entry.command,
          })),
        },
        'Skipping plugin due to missing required binaries',
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
      const importedModule = await importPluginModule(
        candidate.entrypoint,
        candidate.dir,
      );
      this.importSnapshotRoots.push(importedModule.snapshotRootDir);
      const mod = importedModule.module;
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
        declaredCredentials: candidate.manifest.credentials || [],
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

  registerOutputGuard(pluginId: string, guard: PluginOutputGuard): void {
    const guardId = safeString(() => guard.id, '').trim();
    if (!guardId) {
      throw new Error('Plugin output guard is missing `id`.');
    }
    this.outputGuards.push({
      pluginId,
      guard: {
        ...guard,
        id: guardId,
      },
    });
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

  registerInboundWebhook(
    pluginId: string,
    webhook: PluginInboundWebhookDefinition,
  ): void {
    const normalizedName = safeString(() => webhook.name, '').trim();
    if (!normalizedName) {
      throw new Error('Plugin inbound webhook is missing `name`.');
    }
    const method = webhook.method ?? 'POST';
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(
        `Plugin inbound webhook "${normalizedName}" on plugin "${pluginId}" has invalid method "${String(method)}". Supported methods are "GET" and "POST".`,
      );
    }
    const path = buildPluginInboundWebhookPath(pluginId, normalizedName);
    if (this.inboundWebhooks.has(path)) {
      throw new Error(
        `Plugin inbound webhook path "${path}" is already registered.`,
      );
    }
    this.inboundWebhooks.set(path, {
      pluginId,
      path,
      webhook: {
        ...webhook,
        name: normalizedName,
        method,
      },
      logger: this.logger.child({
        pluginId,
        webhookName: normalizedName,
      }) as PluginLogger,
    });
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

  listRegisteredCommands(): PluginCommandSummary[] {
    return [...this.commands.values()]
      .map(({ command }) => ({
        name: command.name,
        description: command.description,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listPluginSummary(): PluginSummary[] {
    return this.plugins.map((plugin) => {
      const commands = [...this.commands.values()]
        .filter((entry) => entry.pluginId === plugin.id)
        .map((entry) => entry.command.name);

      return {
        id: plugin.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        source: plugin.candidate.source,
        enabled: plugin.enabled,
        error: plugin.error,
        commands,
        tools: [...plugin.toolsRegistered],
        hooks: [...plugin.hooksRegistered],
      };
    });
  }

  getSessionWorkspaceRoot(sessionId: string): string | null {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return null;
    return this.sessionWorkspaceRoots.get(normalizedSessionId) || null;
  }

  getSessionUserId(sessionId: string): string | null {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return null;
    return this.sessionUserIds.get(normalizedSessionId) || null;
  }

  private rememberSessionWorkspaceRoot(
    sessionId: string,
    workspacePath?: string,
  ): void {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedWorkspacePath = String(workspacePath || '').trim();
    if (!normalizedSessionId || !normalizedWorkspacePath) return;
    this.sessionWorkspaceRoots.set(
      normalizedSessionId,
      path.resolve(normalizedWorkspacePath),
    );
  }

  private rememberSessionUserId(sessionId: string, userId?: string): void {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedSessionId || !normalizedUserId) return;
    this.sessionUserIds.set(normalizedSessionId, normalizedUserId);
  }

  private createPluginRegistrationSnapshot(): PluginRegistrationSnapshot {
    return {
      plugins: [...this.plugins],
      memoryLayers: [...this.memoryLayers],
      promptHooks: [...this.promptHooks],
      outputGuards: [...this.outputGuards],
      services: [...this.services],
      inboundWebhooks: new Map(this.inboundWebhooks),
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
    this.outputGuards = [...snapshot.outputGuards];
    this.services = [...snapshot.services];
    this.inboundWebhooks = new Map(snapshot.inboundWebhooks);
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

    for (const entry of this.outputGuards) {
      if (entry.pluginId !== pluginId) continue;
      registered.add(`output-guard:${entry.guard.id}`);
    }

    for (const [name, entries] of this.hooks.entries()) {
      if (entries.some((entry) => entry.pluginId === pluginId)) {
        registered.add(name);
      }
    }

    return [...registered].sort((left, right) => left.localeCompare(right));
  }

  private disableFailedMemoryProviderPlugin(
    pluginId: string,
    errorMessage: string,
  ): void {
    const plugin = this.plugins.find((entry) => entry.id === pluginId);
    if (
      !plugin ||
      (plugin.manifest.kind !== 'memory' &&
        plugin.manifest.memoryProvider !== true)
    ) {
      return;
    }

    plugin.enabled = false;
    plugin.status = 'failed';
    plugin.error = errorMessage;

    this.memoryLayers = this.memoryLayers.filter(
      (entry) => entry.pluginId !== pluginId,
    );
    this.promptHooks = this.promptHooks.filter(
      (entry) => entry.pluginId !== pluginId,
    );
    this.outputGuards = this.outputGuards.filter(
      (entry) => entry.pluginId !== pluginId,
    );
    this.services = this.services.filter(
      (entry) => entry.pluginId !== pluginId,
    );

    for (const [name, entry] of this.tools.entries()) {
      if (entry.pluginId === pluginId) {
        this.tools.delete(name);
      }
    }

    for (const [name, entries] of [...this.hooks.entries()]) {
      const remaining = entries.filter((entry) => entry.pluginId !== pluginId);
      if (remaining.length === 0) {
        this.hooks.delete(name);
        continue;
      }
      this.hooks.set(name, remaining);
    }

    plugin.toolsRegistered = this.getPluginToolNames(pluginId);
    plugin.hooksRegistered = this.getPluginHookNames(pluginId);
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

  async dispatchInboundMessage(
    pluginId: string,
    request: PluginDispatchInboundMessageRequest,
  ): Promise<import('../gateway/gateway-types.js').GatewayChatResult> {
    await this.ensureInitialized();
    if (!this.dispatchInboundMessageHost) {
      throw new Error(
        'Plugin inbound-message dispatch is unavailable outside the gateway runtime.',
      );
    }
    return await this.dispatchInboundMessageHost(pluginId, request);
  }

  async handleInboundWebhook(params: {
    method: string;
    pathname: string;
    url: URL;
    req: import('node:http').IncomingMessage;
    res: import('node:http').ServerResponse;
  }): Promise<boolean> {
    await this.ensureInitialized();
    const entry = this.inboundWebhooks.get(params.pathname);
    if (!entry) {
      return false;
    }
    const method = String(params.method || 'GET').toUpperCase();
    if (method !== entry.webhook.method) {
      sendWebhookJson(params.res, 405, { error: 'Method Not Allowed' });
      return true;
    }

    const context: PluginInboundWebhookContext = {
      req: params.req,
      res: params.res,
      url: params.url,
      pluginId: entry.pluginId,
      webhookName: entry.webhook.name,
      method: entry.webhook.method,
      path: entry.path,
      logger: entry.logger,
    };
    try {
      await entry.webhook.handler(context);
    } catch (error) {
      if (!(error instanceof WebhookHttpError)) {
        this.logger.warn(
          {
            pluginId: entry.pluginId,
            webhookName: entry.webhook.name,
            path: entry.path,
            error,
          },
          'Plugin inbound webhook failed',
        );
      }
      throw error;
    }

    if (!params.res.writableEnded) {
      if (!params.res.headersSent) {
        params.res.statusCode = 204;
      }
      params.res.end();
    }
    return true;
  }

  async collectPromptContextDetails(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    workspacePath?: string;
    recentMessages: StoredMessage[];
  }): Promise<PluginPromptContextResult> {
    await this.ensureInitialized();
    this.rememberSessionUserId(params.sessionId, params.userId);
    this.rememberSessionWorkspaceRoot(params.sessionId, params.workspacePath);
    const memoryBehavior = this.getMemoryBehaviorSnapshot();

    const extraContext: string[] = [];
    const pluginIds = new Set<string>();
    for (const entry of [...this.memoryLayers].sort(
      (left, right) => left.layer.priority - right.layer.priority,
    )) {
      if (!entry.layer.getContextForPrompt) continue;
      try {
        const value = await entry.layer.getContextForPrompt({
          sessionId: params.sessionId,
          userId: params.userId,
          agentId: params.agentId,
          workspacePath: params.workspacePath,
          recentMessages: params.recentMessages,
        });
        if (typeof value === 'string' && value.trim()) {
          extraContext.push(value.trim());
          pluginIds.add(entry.pluginId);
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
          pluginIds.add(entry.pluginId);
        }
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, promptHookId: entry.hook.id, error },
          'Plugin prompt hook failed',
        );
      }
    }

    const beforePromptBuildHooks =
      (this.hooks.get('before_prompt_build') as
        | RegisteredHook<'before_prompt_build'>[]
        | undefined) || [];
    for (const entry of beforePromptBuildHooks) {
      const contextLengthBefore = hookContext.extraContext.length;
      try {
        await entry.handler(hookContext);
        if (hookContext.extraContext.length > contextLengthBefore) {
          pluginIds.add(entry.pluginId);
        }
      } catch (error) {
        this.logger.warn(
          { pluginId: entry.pluginId, hookName: 'before_prompt_build', error },
          'Plugin lifecycle hook failed',
        );
      }
    }
    return {
      ...memoryBehavior,
      sections: extraContext.filter(
        (value, index, list) => list.indexOf(value) === index,
      ),
      pluginIds: [...pluginIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }

  async collectPromptContext(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    workspacePath?: string;
    recentMessages: StoredMessage[];
  }): Promise<string[]> {
    const result = await this.collectPromptContextDetails(params);
    return result.sections;
  }

  getMcpServerConfig(name: string): McpServerConfig | null {
    const normalized = String(name || '').trim();
    if (!normalized) return null;
    const config = this.getConfig();
    const entry = config.mcpServers?.[normalized];
    if (!entry) return null;
    return structuredClone(entry);
  }

  async getMemoryLayerBehavior(): Promise<PluginMemoryBehavior> {
    await this.ensureInitialized();
    return this.getMemoryBehaviorSnapshot();
  }

  async notifySessionStart(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    workspacePath?: string;
  }): Promise<void> {
    await this.ensureInitialized();
    this.rememberSessionUserId(params.sessionId, params.userId);
    this.rememberSessionWorkspaceRoot(params.sessionId, params.workspacePath);
    await this.dispatchHook('session_start', params);
  }

  async notifySessionEnd(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    workspacePath?: string;
  }): Promise<void> {
    await this.ensureInitialized();
    this.rememberSessionUserId(params.sessionId, params.userId);
    await this.dispatchHook('session_end', params);
    this.sessionWorkspaceRoots.delete(params.sessionId);
    this.sessionUserIds.delete(params.sessionId);
  }

  async notifyBeforeAgentStart(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId: string;
    model?: string;
  }): Promise<void> {
    await this.ensureInitialized();
    this.rememberSessionUserId(params.sessionId, params.userId);
    await this.dispatchHook('before_agent_start', params);
  }

  async notifyAgentEnd(context: PluginAgentEndContext): Promise<void> {
    await this.ensureInitialized();
    this.rememberSessionUserId(context.sessionId, context.userId);
    await this.dispatchHook('agent_end', context);
  }

  hasOutputGuards(): boolean {
    return this.outputGuards.length > 0;
  }

  async applyOutputGuards(
    context: PluginOutputGuardContext,
  ): Promise<PluginOutputGuardOutcome> {
    await this.ensureInitialized();
    if (this.outputGuards.length === 0) {
      return {
        resultText: context.resultText,
        blocked: false,
        events: [],
      };
    }
    const ordered = [...this.outputGuards].sort((left, right) => {
      const leftPriority = left.guard.priority ?? 0;
      const rightPriority = right.guard.priority ?? 0;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.guard.id.localeCompare(right.guard.id);
    });

    const events: PluginOutputGuardEvent[] = [];
    let resultText = context.resultText;
    let blocked = false;

    for (const entry of ordered) {
      const guardContext: PluginOutputGuardContext = {
        ...context,
        resultText,
      };
      let decision: PluginOutputGuardDecision | null = null;
      try {
        const value = await entry.guard.inspect(guardContext);
        if (value && typeof value === 'object' && 'action' in value) {
          const action = (value as { action?: unknown }).action;
          if (
            action === 'allow' ||
            action === 'rewrite' ||
            action === 'block'
          ) {
            decision = value as PluginOutputGuardDecision;
          } else {
            this.logger.warn(
              {
                pluginId: entry.pluginId,
                guardId: entry.guard.id,
                action,
              },
              'Plugin output guard returned unknown action; treating as allow',
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          {
            pluginId: entry.pluginId,
            guardId: entry.guard.id,
            error,
          },
          'Plugin output guard failed; allowing original output',
        );
        continue;
      }
      if (!decision || decision.action === 'allow') {
        events.push({
          pluginId: entry.pluginId,
          guardId: entry.guard.id,
          action: 'allow',
        });
        continue;
      }
      if (decision.action === 'rewrite') {
        const rewritten = String(decision.text ?? '').trim();
        if (!rewritten) {
          this.logger.warn(
            {
              pluginId: entry.pluginId,
              guardId: entry.guard.id,
            },
            'Plugin output guard returned empty rewrite; allowing original output',
          );
          continue;
        }
        events.push({
          pluginId: entry.pluginId,
          guardId: entry.guard.id,
          action: 'rewrite',
          reason: decision.reason,
          before: resultText,
          after: rewritten,
        });
        resultText = rewritten;
        continue;
      }
      const reason =
        String(decision.reason || '').trim() ||
        'Output blocked by plugin guard.';
      const replacement = String(decision.replacement || '').trim();
      events.push({
        pluginId: entry.pluginId,
        guardId: entry.guard.id,
        action: 'block',
        reason,
        before: resultText,
        after: replacement || undefined,
      });
      resultText = replacement || reason;
      blocked = true;
      break;
    }

    return {
      resultText,
      blocked,
      events,
    };
  }

  async notifyTurnComplete(params: {
    sessionId: string;
    userId: string;
    agentId: string;
    workspacePath?: string;
    messages: StoredMessage[];
  }): Promise<void> {
    await this.ensureInitialized();
    this.rememberSessionUserId(params.sessionId, params.userId);
    this.rememberSessionWorkspaceRoot(params.sessionId, params.workspacePath);
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
    const previousWorkspaceRoot =
      this.sessionWorkspaceRoots.get(context.previousSessionId) || null;
    const previousUserId =
      this.sessionUserIds.get(context.previousSessionId) || null;
    if (previousWorkspaceRoot) {
      this.sessionWorkspaceRoots.set(context.sessionId, previousWorkspaceRoot);
    }
    if (previousUserId) {
      this.sessionUserIds.set(context.sessionId, previousUserId);
    } else {
      this.rememberSessionUserId(context.sessionId, context.userId);
    }
    this.sessionWorkspaceRoots.delete(context.previousSessionId);
    this.sessionUserIds.delete(context.previousSessionId);
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

  async notifyMemoryWrites(params: {
    sessionId: string;
    agentId: string;
    channelId: string;
    toolExecutions: ToolExecution[];
  }): Promise<void> {
    await this.ensureInitialized();
    for (const context of this.collectMemoryWriteContexts(params)) {
      await this.dispatchHook('memory_write', context);
    }
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

  private getMemoryBehaviorSnapshot(): PluginMemoryBehavior {
    return {
      replacesBuiltInMemory: this.memoryLayers.some(
        (entry) => entry.layer.replacesBuiltInMemory === true,
      ),
    };
  }

  private collectMemoryWriteContexts(params: {
    sessionId: string;
    agentId: string;
    channelId: string;
    toolExecutions: ToolExecution[];
  }): PluginMemoryWriteContext[] {
    const contexts: PluginMemoryWriteContext[] = [];
    for (const execution of params.toolExecutions) {
      if (
        String(execution.name || '')
          .trim()
          .toLowerCase() !== 'memory'
      ) {
        continue;
      }
      if (execution.isError || execution.blocked) continue;

      const args = parseJsonObject(execution.arguments || '');
      if (!args) continue;

      const action = normalizeMemoryWriteAction(args.action);
      if (!action) continue;

      const memoryFilePath = resolveMemoryWriteFilePath(args, execution.result);
      if (!memoryFilePath) continue;

      const context: PluginMemoryWriteContext = {
        sessionId: params.sessionId,
        agentId: params.agentId,
        channelId: params.channelId,
        action,
        memoryFilePath,
        arguments: args,
        result: String(execution.result || ''),
      };

      if (typeof args.content === 'string') {
        context.content = args.content;
      }
      if (typeof args.old_text === 'string') {
        context.oldText = args.old_text;
      }
      if (typeof args.new_text === 'string') {
        context.newText = args.new_text;
      }

      contexts.push(context);
    }
    return contexts;
  }

  private async startMemoryLayers(): Promise<void> {
    for (const entry of this.getOrderedMemoryLayerEntries()) {
      try {
        const start = entry.layer.start;
        if (!start) continue;
        await start.call(entry.layer);
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : String(error || 'Unknown error');
        this.logger.warn(
          {
            pluginId: entry.pluginId,
            layerId: safeString(() => entry.layer.id, '(unknown)'),
            error,
          },
          'Plugin memory layer failed to start',
        );
        this.disableFailedMemoryProviderPlugin(entry.pluginId, errorMessage);
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
let singletonDispatchInboundMessageHost:
  | ((
      pluginId: string,
      request: PluginDispatchInboundMessageRequest,
    ) => Promise<import('../gateway/gateway-types.js').GatewayChatResult>)
  | null = null;

export function getPluginManager(): PluginManager {
  singleton ??= new PluginManager({
    cwd: process.cwd(),
    getRuntimeConfig,
    dispatchInboundMessage: singletonDispatchInboundMessageHost || undefined,
  });
  return singleton;
}

export function setPluginInboundMessageDispatcher(
  dispatcher:
    | ((
        pluginId: string,
        request: PluginDispatchInboundMessageRequest,
      ) => Promise<import('../gateway/gateway-types.js').GatewayChatResult>)
    | null,
): void {
  singletonDispatchInboundMessageHost = dispatcher;
  singleton?.setDispatchInboundMessageHost(dispatcher);
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

export function findLoadedPluginCommand(
  name: string,
): PluginCommandDefinition | undefined {
  if (!singleton) return undefined;
  return singleton.findCommand(name);
}

export function listLoadedPluginCommands(): PluginCommandSummary[] {
  if (!singleton) return [];
  return singleton.listRegisteredCommands();
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
