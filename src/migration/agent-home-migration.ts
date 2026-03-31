import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  getRuntimeConfig,
  type RuntimeConfig,
  runtimeConfigPath,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  loadRuntimeSecrets,
  type RuntimeSecretKey,
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import type { McpServerConfig } from '../types/models.js';
import { ensureBootstrapFiles } from '../workspace.js';

export type AgentMigrationSource = 'openclaw' | 'hermes';

type MigrationItemStatus =
  | 'migrated'
  | 'skipped'
  | 'conflict'
  | 'error'
  | 'archived';

interface MigrationItem {
  kind: string;
  source: string | null;
  destination: string | null;
  status: MigrationItemStatus;
  reason: string;
  details?: Record<string, unknown>;
}

export interface AgentMigrationOptions {
  sourceKind: AgentMigrationSource;
  sourceRoot?: string;
  execute?: boolean;
  overwrite?: boolean;
  migrateSecrets?: boolean;
}

export interface AgentMigrationResult {
  sourceKind: AgentMigrationSource;
  sourceRoot: string;
  targetRoot: string;
  execute: boolean;
  overwrite: boolean;
  migrateSecrets: boolean;
  outputDir: string | null;
  summary: Record<MigrationItemStatus | 'total', number>;
  items: MigrationItem[];
}

interface SourceSnapshot {
  config: Record<string, unknown>;
  env: Record<string, string>;
}

interface SourceAdapter {
  readonly kind: AgentMigrationSource;
  readonly defaultRoot: string;
  load(sourceRoot: string): SourceSnapshot;
  resolveWorkspaceFile(sourceRoot: string, filename: string): string | null;
  listSkillRoots(sourceRoot: string): string[];
  extractModel(config: Record<string, unknown>): string;
  extractMcpServers(
    config: Record<string, unknown>,
  ): Record<string, McpServerConfig>;
  extractSecrets(
    snapshot: SourceSnapshot,
  ): Partial<Record<RuntimeSecretKey, string>>;
  applyConfig(
    draft: RuntimeConfig,
    snapshot: SourceSnapshot,
    sourceRoot: string,
    overwrite: boolean,
    addItem: (item: MigrationItem) => void,
  ): void;
  archiveCandidates(sourceRoot: string): string[];
}

const WORKSPACE_FILES = [
  'SOUL.md',
  'AGENTS.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
] as const;

const RUNTIME_SECRET_KEYS: RuntimeSecretKey[] = [
  'HYBRIDAI_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DISCORD_TOKEN',
  'EMAIL_PASSWORD',
  'IMESSAGE_PASSWORD',
  'MSTEAMS_APP_PASSWORD',
  'WEB_API_TOKEN',
  'GATEWAY_API_TOKEN',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseYamlFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || !value) continue;
    values[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mergeUniqueStrings(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  const seen = new Set(existing);
  for (const item of incoming) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged;
}

function resolveDefaultSourceRoot(sourceKind: AgentMigrationSource): string {
  return path.join(
    os.homedir(),
    sourceKind === 'openclaw' ? '.openclaw' : '.hermes',
  );
}

export function detectAgentMigrationSourceRoot(
  sourceKind: AgentMigrationSource,
): string | null {
  const sourceRoot = resolveDefaultSourceRoot(sourceKind);
  return fs.existsSync(sourceRoot) ? sourceRoot : null;
}

export function detectAvailableAgentMigrationSources(): AgentMigrationSource[] {
  const available: AgentMigrationSource[] = [];
  if (detectAgentMigrationSourceRoot('openclaw')) available.push('openclaw');
  if (detectAgentMigrationSourceRoot('hermes')) available.push('hermes');
  return available;
}

function resolveSecretInput(
  value: unknown,
  env: Record<string, string>,
): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const envMatch = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (envMatch) return env[envMatch[1]]?.trim() || null;
    return trimmed;
  }
  if (isRecord(value)) {
    const source = typeof value.source === 'string' ? value.source.trim() : '';
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (source === 'env' && id) return env[id]?.trim() || null;
  }
  return null;
}

function readRuntimeSecretsFile(): Partial<Record<RuntimeSecretKey, string>> {
  const filePath = runtimeSecretsPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!isRecord(parsed)) return {};
    const secrets: Partial<Record<RuntimeSecretKey, string>> = {};
    for (const key of RUNTIME_SECRET_KEYS) {
      const value = parsed[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) secrets[key] = trimmed;
    }
    return secrets;
  } catch {
    return {};
  }
}

function normalizeMcpTransport(
  value: unknown,
  command: string,
  url: string,
): McpServerConfig['transport'] {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value;
  if (command) return 'stdio';
  if (url) return url.includes('/sse') ? 'sse' : 'http';
  return 'stdio';
}

function normalizeMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!isRecord(raw)) return {};
  const normalized: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const command =
      typeof value.command === 'string' ? value.command.trim() : '';
    const args = normalizeStringArray(value.args);
    const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : '';
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    const env = isRecord(value.env)
      ? Object.fromEntries(
          Object.entries(value.env)
            .filter(([, entry]) => typeof entry === 'string')
            .map(([key, entry]) => [key, String(entry).trim()]),
        )
      : {};
    const headers = isRecord(value.headers)
      ? Object.fromEntries(
          Object.entries(value.headers)
            .filter(([, entry]) => typeof entry === 'string')
            .map(([key, entry]) => [key, String(entry).trim()]),
        )
      : {};
    const transport = normalizeMcpTransport(value.transport, command, url);
    normalized[name] = {
      transport,
      ...(command ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...(url ? { url } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    };
  }
  return normalized;
}

function applyImportedModel(draft: RuntimeConfig, model: string): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  draft.hybridai.defaultModel = trimmed;
  if (trimmed.startsWith('openrouter/')) {
    draft.openrouter.enabled = true;
    draft.openrouter.models = mergeUniqueStrings(draft.openrouter.models, [
      trimmed,
    ]);
    return;
  }
  if (trimmed.startsWith('mistral/')) {
    draft.mistral.enabled = true;
    draft.mistral.models = mergeUniqueStrings(draft.mistral.models, [trimmed]);
    return;
  }
  if (trimmed.startsWith('huggingface/')) {
    draft.huggingface.enabled = true;
    draft.huggingface.models = mergeUniqueStrings(draft.huggingface.models, [
      trimmed,
    ]);
    return;
  }
  if (trimmed.startsWith('openai-codex/')) {
    draft.codex.models = mergeUniqueStrings(draft.codex.models, [trimmed]);
  }
}

function buildSummary(
  items: MigrationItem[],
): Record<MigrationItemStatus | 'total', number> {
  return {
    total: items.length,
    migrated: items.filter((item) => item.status === 'migrated').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    conflict: items.filter((item) => item.status === 'conflict').length,
    error: items.filter((item) => item.status === 'error').length,
    archived: items.filter((item) => item.status === 'archived').length,
  };
}

function writeReport(result: AgentMigrationResult): void {
  if (!result.outputDir) return;
  ensureDir(result.outputDir);
  fs.writeFileSync(
    path.join(result.outputDir, 'report.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf-8',
  );
  const lines = [
    `# ${result.sourceKind} -> HybridClaw Migration`,
    '',
    `- Source: \`${result.sourceRoot}\``,
    `- Target: \`${result.targetRoot}\``,
    `- Mode: ${result.execute ? 'execute' : 'dry-run'}`,
    '',
    '## Summary',
    '',
    `- total: ${result.summary.total}`,
    `- migrated: ${result.summary.migrated}`,
    `- skipped: ${result.summary.skipped}`,
    `- conflict: ${result.summary.conflict}`,
    `- error: ${result.summary.error}`,
    `- archived: ${result.summary.archived}`,
    '',
    '## Items',
    '',
  ];
  for (const item of result.items) {
    lines.push(
      `- ${item.status} ${item.kind}: \`${item.source || '(n/a)'}\` -> \`${item.destination || '(n/a)'}\`${item.reason ? ` (${item.reason})` : ''}`,
    );
  }
  fs.writeFileSync(
    path.join(result.outputDir, 'summary.md'),
    `${lines.join('\n')}\n`,
    'utf-8',
  );
}

function makeItem(
  kind: string,
  source: string | null,
  destination: string | null,
  status: MigrationItemStatus,
  reason = '',
  details?: Record<string, unknown>,
): MigrationItem {
  return {
    kind,
    source,
    destination,
    status,
    reason,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function backupTarget(targetPath: string, backupRoot: string): string | null {
  if (!fs.existsSync(targetPath)) return null;
  const relative = path.relative(path.parse(targetPath).root, targetPath);
  const destination = path.join(backupRoot, relative);
  ensureDir(path.dirname(destination));
  if (fs.statSync(targetPath).isDirectory()) {
    fs.cpSync(targetPath, destination, { recursive: true });
  } else {
    fs.copyFileSync(targetPath, destination);
  }
  return destination;
}

function copyFileWithConflictHandling(params: {
  sourcePath: string;
  destinationPath: string;
  execute: boolean;
  overwrite: boolean;
  backupRoot: string | null;
  replaceTemplate: boolean;
  kind: string;
}): MigrationItem {
  const {
    sourcePath,
    destinationPath,
    execute,
    overwrite,
    backupRoot,
    replaceTemplate,
    kind,
  } = params;
  if (!fs.existsSync(sourcePath)) {
    return makeItem(
      kind,
      sourcePath,
      destinationPath,
      'skipped',
      'Source missing',
    );
  }

  if (fs.existsSync(destinationPath)) {
    const existing = readTextFile(destinationPath);
    const incoming = readTextFile(sourcePath);
    if (existing === incoming) {
      return makeItem(
        kind,
        sourcePath,
        destinationPath,
        'skipped',
        'Already matches',
      );
    }
    if (!overwrite && !replaceTemplate) {
      return makeItem(
        kind,
        sourcePath,
        destinationPath,
        'conflict',
        'Destination already customized',
      );
    }
  }

  let backupPath: string | null = null;
  if (execute) {
    ensureDir(path.dirname(destinationPath));
    if (backupRoot) {
      backupPath = backupTarget(destinationPath, backupRoot);
    }
    fs.copyFileSync(sourcePath, destinationPath);
  }

  return makeItem(kind, sourcePath, destinationPath, 'migrated', '', {
    ...(backupPath ? { backup: backupPath } : {}),
    ...(execute ? {} : { dryRun: true }),
  });
}

function maybeTemplateReplacement(destinationPath: string): boolean {
  const filename = path.basename(destinationPath);
  const templatePath = resolveInstallPath('templates', filename);
  if (!fs.existsSync(destinationPath) || !fs.existsSync(templatePath)) {
    return false;
  }
  try {
    return readTextFile(destinationPath) === readTextFile(templatePath);
  } catch {
    return false;
  }
}

function sanitizeSkillDirName(
  sourceKind: AgentMigrationSource,
  name: string,
): string {
  const base = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${sourceKind}-${base || 'skill'}`;
}

function copySkillDirs(params: {
  sourceKind: AgentMigrationSource;
  sourceRoots: string[];
  targetRoot: string;
  execute: boolean;
  overwrite: boolean;
  backupRoot: string | null;
}): MigrationItem[] {
  const items: MigrationItem[] = [];
  ensureDir(params.targetRoot);
  for (const sourceRoot of params.sourceRoots) {
    if (!fs.existsSync(sourceRoot)) continue;
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(sourceRoot, entry.name);
      if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
      let destination = path.join(params.targetRoot, entry.name);
      if (fs.existsSync(destination) && !params.overwrite) {
        const sourceSkill = readTextFile(path.join(skillDir, 'SKILL.md'));
        const destSkillPath = path.join(destination, 'SKILL.md');
        if (
          fs.existsSync(destSkillPath) &&
          readTextFile(destSkillPath) === sourceSkill
        ) {
          items.push(
            makeItem(
              'skill',
              skillDir,
              destination,
              'skipped',
              'Already imported',
            ),
          );
          continue;
        }
        destination = path.join(
          params.targetRoot,
          sanitizeSkillDirName(params.sourceKind, entry.name),
        );
      }

      let backupPath: string | null = null;
      if (params.execute) {
        if (params.backupRoot) {
          backupPath = backupTarget(destination, params.backupRoot);
        }
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(skillDir, destination, { recursive: true });
      }

      items.push(
        makeItem('skill', skillDir, destination, 'migrated', '', {
          ...(backupPath ? { backup: backupPath } : {}),
          ...(destination.endsWith(entry.name) ? {} : { renamed: true }),
          ...(params.execute ? {} : { dryRun: true }),
        }),
      );
    }
  }
  if (items.length === 0) {
    items.push(
      makeItem(
        'skill',
        params.sourceRoots.join(','),
        params.targetRoot,
        'skipped',
        'No importable skills found',
      ),
    );
  }
  return items;
}

function archiveSourcePaths(params: {
  sourceRoot: string;
  candidates: string[];
  archiveRoot: string | null;
  execute: boolean;
}): MigrationItem[] {
  const items: MigrationItem[] = [];
  for (const candidate of params.candidates) {
    if (!fs.existsSync(candidate)) continue;
    const relative = path.relative(params.sourceRoot, candidate);
    const destination = params.archiveRoot
      ? path.join(params.archiveRoot, relative)
      : null;
    if (params.execute && destination) {
      ensureDir(path.dirname(destination));
      if (fs.statSync(candidate).isDirectory()) {
        fs.cpSync(candidate, destination, { recursive: true });
      } else {
        fs.copyFileSync(candidate, destination);
      }
    }
    items.push(
      makeItem(
        'archive',
        candidate,
        destination,
        'archived',
        'Copied for manual review',
      ),
    );
  }
  return items;
}

const openClawAdapter: SourceAdapter = {
  kind: 'openclaw',
  defaultRoot: resolveDefaultSourceRoot('openclaw'),
  load(sourceRoot) {
    return {
      config: parseJsonFile(path.join(sourceRoot, 'openclaw.json')),
      env: parseEnvFile(path.join(sourceRoot, '.env')),
    };
  },
  resolveWorkspaceFile(sourceRoot, filename) {
    const candidates = [
      path.join(sourceRoot, 'workspace', filename),
      path.join(sourceRoot, 'workspace.default', filename),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  },
  listSkillRoots(sourceRoot) {
    return [
      path.join(sourceRoot, 'workspace', 'skills'),
      path.join(sourceRoot, 'workspace.default', 'skills'),
      path.join(sourceRoot, 'skills'),
    ].filter((candidate) => fs.existsSync(candidate));
  },
  extractModel(config) {
    const agents = isRecord(config.agents) ? config.agents : {};
    const defaults = isRecord(agents.defaults) ? agents.defaults : {};
    const value = defaults.model;
    if (typeof value === 'string') return value.trim();
    if (isRecord(value) && typeof value.primary === 'string') {
      return value.primary.trim();
    }
    return '';
  },
  extractMcpServers(config) {
    const mcp = isRecord(config.mcp) ? config.mcp : {};
    return normalizeMcpServers(mcp.servers);
  },
  extractSecrets(snapshot) {
    const secrets: Partial<Record<RuntimeSecretKey, string>> = {};
    for (const key of RUNTIME_SECRET_KEYS) {
      const value = snapshot.env[key];
      if (value?.trim()) secrets[key] = value.trim();
    }
    const channels = isRecord(snapshot.config.channels)
      ? snapshot.config.channels
      : {};
    const discord = isRecord(channels.discord) ? channels.discord : {};
    if (typeof discord.token === 'string' && discord.token.trim()) {
      secrets.DISCORD_TOKEN = discord.token.trim();
    }
    const models = isRecord(snapshot.config.models)
      ? snapshot.config.models
      : {};
    const providers = isRecord(models.providers) ? models.providers : {};
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (!isRecord(providerConfig)) continue;
      const resolved = resolveSecretInput(providerConfig.apiKey, snapshot.env);
      if (!resolved) continue;
      const name = providerName.toLowerCase();
      if (name.includes('hybridai') && !secrets.HYBRIDAI_API_KEY) {
        secrets.HYBRIDAI_API_KEY = resolved;
      } else if (name.includes('openrouter') && !secrets.OPENROUTER_API_KEY) {
        secrets.OPENROUTER_API_KEY = resolved;
      } else if (
        (name.includes('huggingface') || name.includes('hf')) &&
        !secrets.HF_TOKEN
      ) {
        secrets.HF_TOKEN = resolved;
      } else if (name.includes('mistral') && !secrets.MISTRAL_API_KEY) {
        secrets.MISTRAL_API_KEY = resolved;
      } else if (
        (name.includes('openai') || name.includes('codex')) &&
        !secrets.OPENAI_API_KEY
      ) {
        secrets.OPENAI_API_KEY = resolved;
      }
    }
    return secrets;
  },
  applyConfig(draft, snapshot, sourceRoot, overwrite, addItem) {
    const model = this.extractModel(snapshot.config);
    if (model) {
      const currentModel = draft.hybridai.defaultModel.trim();
      if (!currentModel || currentModel === 'gpt-4.1-mini' || overwrite) {
        applyImportedModel(draft, model);
        addItem(
          makeItem(
            'config:model',
            path.join(sourceRoot, 'openclaw.json'),
            runtimeConfigPath(),
            'migrated',
            '',
            { model },
          ),
        );
      } else if (currentModel === model) {
        addItem(
          makeItem(
            'config:model',
            path.join(sourceRoot, 'openclaw.json'),
            runtimeConfigPath(),
            'skipped',
            'Default model already matches',
          ),
        );
      } else {
        addItem(
          makeItem(
            'config:model',
            path.join(sourceRoot, 'openclaw.json'),
            runtimeConfigPath(),
            'conflict',
            'HybridClaw default model already set',
            { currentModel, incomingModel: model },
          ),
        );
      }
    }

    const channels = isRecord(snapshot.config.channels)
      ? snapshot.config.channels
      : {};
    const discord = isRecord(channels.discord) ? channels.discord : {};
    const whatsapp = isRecord(channels.whatsapp) ? channels.whatsapp : {};
    const allowDiscord = normalizeStringArray(discord.allowFrom);
    if (allowDiscord.length > 0) {
      draft.discord.commandAllowedUserIds = mergeUniqueStrings(
        draft.discord.commandAllowedUserIds,
        allowDiscord,
      );
      draft.discord.commandMode = 'restricted';
      draft.discord.commandsOnly = true;
      addItem(
        makeItem(
          'config:discord',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          { importedUsers: allowDiscord.length },
        ),
      );
    }
    const prefix =
      typeof discord.prefix === 'string' ? discord.prefix.trim() : '';
    if (prefix && (draft.discord.prefix === '!claw' || overwrite)) {
      draft.discord.prefix = prefix;
    }

    const allowWhatsApp = normalizeStringArray(whatsapp.allowFrom);
    if (allowWhatsApp.length > 0) {
      draft.whatsapp.allowFrom = mergeUniqueStrings(
        draft.whatsapp.allowFrom,
        allowWhatsApp,
      );
      draft.whatsapp.dmPolicy = 'allowlist';
      addItem(
        makeItem(
          'config:whatsapp',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          { importedUsers: allowWhatsApp.length },
        ),
      );
    }
  },
  archiveCandidates(sourceRoot) {
    return [
      path.join(sourceRoot, 'openclaw.json'),
      path.join(sourceRoot, 'workspace', 'BOOTSTRAP.md'),
      path.join(sourceRoot, 'workspace.default', 'BOOTSTRAP.md'),
    ];
  },
};

const hermesAdapter: SourceAdapter = {
  kind: 'hermes',
  defaultRoot: resolveDefaultSourceRoot('hermes'),
  load(sourceRoot) {
    return {
      config: parseYamlFile(path.join(sourceRoot, 'config.yaml')),
      env: parseEnvFile(path.join(sourceRoot, '.env')),
    };
  },
  resolveWorkspaceFile(sourceRoot, filename) {
    const candidate = path.join(sourceRoot, filename);
    return fs.existsSync(candidate) ? candidate : null;
  },
  listSkillRoots(sourceRoot) {
    return [path.join(sourceRoot, 'skills')].filter((candidate) =>
      fs.existsSync(candidate),
    );
  },
  extractModel(config) {
    const value = config.model;
    if (typeof value === 'string') return value.trim();
    if (isRecord(value)) {
      if (typeof value.default === 'string') return value.default.trim();
      if (typeof value.primary === 'string') return value.primary.trim();
    }
    return '';
  },
  extractMcpServers(config) {
    return normalizeMcpServers(config.mcp_servers);
  },
  extractSecrets(snapshot) {
    const secrets: Partial<Record<RuntimeSecretKey, string>> = {};
    for (const key of RUNTIME_SECRET_KEYS) {
      const value = snapshot.env[key];
      if (value?.trim()) secrets[key] = value.trim();
    }
    const aliasMap: Array<[string, RuntimeSecretKey]> = [
      ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN'],
      ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
    ];
    for (const [from, to] of aliasMap) {
      const value = snapshot.env[from];
      if (value?.trim() && !secrets[to]) secrets[to] = value.trim();
    }
    return secrets;
  },
  applyConfig(draft, snapshot, sourceRoot, overwrite, addItem) {
    const model = this.extractModel(snapshot.config);
    if (!model) return;
    const currentModel = draft.hybridai.defaultModel.trim();
    if (!currentModel || currentModel === 'gpt-4.1-mini' || overwrite) {
      applyImportedModel(draft, model);
      addItem(
        makeItem(
          'config:model',
          path.join(sourceRoot, 'config.yaml'),
          runtimeConfigPath(),
          'migrated',
          '',
          { model },
        ),
      );
      return;
    }
    if (currentModel === model) {
      addItem(
        makeItem(
          'config:model',
          path.join(sourceRoot, 'config.yaml'),
          runtimeConfigPath(),
          'skipped',
          'Default model already matches',
        ),
      );
      return;
    }
    addItem(
      makeItem(
        'config:model',
        path.join(sourceRoot, 'config.yaml'),
        runtimeConfigPath(),
        'conflict',
        'HybridClaw default model already set',
        { currentModel, incomingModel: model },
      ),
    );
  },
  archiveCandidates(sourceRoot) {
    return [path.join(sourceRoot, 'config.yaml')];
  },
};

function getAdapter(sourceKind: AgentMigrationSource): SourceAdapter {
  return sourceKind === 'openclaw' ? openClawAdapter : hermesAdapter;
}

export async function migrateAgentHome(
  options: AgentMigrationOptions,
): Promise<AgentMigrationResult> {
  const adapter = getAdapter(options.sourceKind);
  const sourceRoot = path.resolve(options.sourceRoot || adapter.defaultRoot);
  const execute = options.execute !== false;
  const overwrite = options.overwrite === true;
  const migrateSecrets = options.migrateSecrets === true;
  const targetRoot = path.dirname(runtimeConfigPath());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = execute
    ? path.join(targetRoot, 'migration', options.sourceKind, timestamp)
    : null;
  const backupRoot = outputDir ? path.join(outputDir, 'backups') : null;
  const archiveRoot = outputDir ? path.join(outputDir, 'archive') : null;
  const items: MigrationItem[] = [];
  const addItem = (item: MigrationItem) => {
    items.push(item);
  };

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    const result: AgentMigrationResult = {
      sourceKind: options.sourceKind,
      sourceRoot,
      targetRoot,
      execute,
      overwrite,
      migrateSecrets,
      outputDir,
      summary: buildSummary([
        makeItem(
          'source',
          sourceRoot,
          targetRoot,
          'error',
          'Source directory does not exist',
        ),
      ]),
      items: [
        makeItem(
          'source',
          sourceRoot,
          targetRoot,
          'error',
          'Source directory does not exist',
        ),
      ],
    };
    if (outputDir) writeReport(result);
    return result;
  }

  const snapshot = adapter.load(sourceRoot);
  ensureBootstrapFiles(DEFAULT_AGENT_ID);
  const workspaceRoot = agentWorkspaceDir(DEFAULT_AGENT_ID);

  for (const filename of WORKSPACE_FILES) {
    const sourcePath = adapter.resolveWorkspaceFile(sourceRoot, filename);
    if (!sourcePath) {
      addItem(
        makeItem(
          'workspace-file',
          path.join(sourceRoot, filename),
          path.join(workspaceRoot, filename),
          'skipped',
          'No compatible source file found',
        ),
      );
      continue;
    }
    addItem(
      copyFileWithConflictHandling({
        sourcePath,
        destinationPath: path.join(workspaceRoot, filename),
        execute,
        overwrite,
        backupRoot,
        replaceTemplate: maybeTemplateReplacement(
          path.join(workspaceRoot, filename),
        ),
        kind: 'workspace-file',
      }),
    );
  }

  if (migrateSecrets) {
    const incomingSecrets = adapter.extractSecrets(snapshot);
    const existingSecrets = readRuntimeSecretsFile();
    const updates: Partial<Record<RuntimeSecretKey, string | null>> = {};
    const skippedKeys: string[] = [];
    const conflictKeys: string[] = [];
    for (const [key, value] of Object.entries(incomingSecrets) as Array<
      [RuntimeSecretKey, string]
    >) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const current = (existingSecrets[key] || '').trim();
      if (!current || current === trimmed || overwrite) {
        updates[key] = trimmed;
        if (current === trimmed) skippedKeys.push(key);
        continue;
      }
      conflictKeys.push(key);
    }
    const changedKeys = Object.keys(updates).filter(
      (key) =>
        (existingSecrets[key as RuntimeSecretKey] || '').trim() !==
        (updates[key as RuntimeSecretKey] || '').trim(),
    );
    if (changedKeys.length > 0 && execute) {
      if (backupRoot) {
        backupTarget(runtimeSecretsPath(), backupRoot);
      }
      saveRuntimeSecrets(updates);
      loadRuntimeSecrets();
      addItem(
        makeItem(
          'secrets',
          path.join(
            sourceRoot,
            adapter.kind === 'hermes' ? '.env' : 'openclaw.json',
          ),
          runtimeSecretsPath(),
          'migrated',
          '',
          { importedKeys: changedKeys },
        ),
      );
    } else if (changedKeys.length > 0) {
      addItem(
        makeItem(
          'secrets',
          path.join(
            sourceRoot,
            adapter.kind === 'hermes' ? '.env' : 'openclaw.json',
          ),
          runtimeSecretsPath(),
          'migrated',
          '',
          { importedKeys: changedKeys, dryRun: true },
        ),
      );
    } else {
      addItem(
        makeItem(
          'secrets',
          path.join(
            sourceRoot,
            adapter.kind === 'hermes' ? '.env' : 'openclaw.json',
          ),
          runtimeSecretsPath(),
          conflictKeys.length > 0 ? 'conflict' : 'skipped',
          conflictKeys.length > 0
            ? 'Secrets already exist with different values'
            : 'No compatible secrets found',
          {
            ...(conflictKeys.length > 0
              ? { conflictingKeys: conflictKeys }
              : {}),
            ...(skippedKeys.length > 0 ? { unchangedKeys: skippedKeys } : {}),
          },
        ),
      );
    }
  } else {
    addItem(
      makeItem(
        'secrets',
        sourceRoot,
        runtimeSecretsPath(),
        'skipped',
        'Secret migration disabled',
      ),
    );
  }

  const existingConfig = getRuntimeConfig();
  const existingMcpKeys = new Set(Object.keys(existingConfig.mcpServers));
  const incomingMcpServers = adapter.extractMcpServers(snapshot.config);
  if (
    Object.keys(incomingMcpServers).length > 0 ||
    Object.keys(snapshot.config).length > 0
  ) {
    if (execute && backupRoot) {
      backupTarget(runtimeConfigPath(), backupRoot);
    }
    const applyConfigChanges = (draft: RuntimeConfig) => {
      adapter.applyConfig(draft, snapshot, sourceRoot, overwrite, addItem);
      for (const [name, config] of Object.entries(incomingMcpServers)) {
        if (draft.mcpServers[name] && !overwrite) continue;
        draft.mcpServers[name] = config;
      }
    };
    if (execute) {
      updateRuntimeConfig((draft) => {
        applyConfigChanges(draft);
      });
    } else {
      const draft = JSON.parse(
        JSON.stringify(getRuntimeConfig()),
      ) as RuntimeConfig;
      applyConfigChanges(draft);
    }
    const importedMcp = Object.keys(incomingMcpServers).filter(
      (name) => overwrite || !existingMcpKeys.has(name),
    );
    const conflictedMcp = Object.keys(incomingMcpServers).filter(
      (name) => existingMcpKeys.has(name) && !overwrite,
    );
    if (importedMcp.length > 0) {
      addItem(
        makeItem(
          'config:mcp',
          sourceRoot,
          runtimeConfigPath(),
          'migrated',
          '',
          { servers: importedMcp, ...(execute ? {} : { dryRun: true }) },
        ),
      );
    } else if (Object.keys(incomingMcpServers).length > 0) {
      addItem(
        makeItem(
          'config:mcp',
          sourceRoot,
          runtimeConfigPath(),
          conflictedMcp.length > 0 ? 'conflict' : 'skipped',
          conflictedMcp.length > 0
            ? 'MCP servers already exist'
            : 'No compatible MCP servers found',
          { conflictingServers: conflictedMcp },
        ),
      );
    }
  }

  for (const item of copySkillDirs({
    sourceKind: options.sourceKind,
    sourceRoots: adapter.listSkillRoots(sourceRoot),
    targetRoot: path.join(targetRoot, 'skills'),
    execute,
    overwrite,
    backupRoot,
  })) {
    addItem(item);
  }

  for (const item of archiveSourcePaths({
    sourceRoot,
    candidates: adapter.archiveCandidates(sourceRoot),
    archiveRoot,
    execute,
  })) {
    addItem(item);
  }

  const result: AgentMigrationResult = {
    sourceKind: options.sourceKind,
    sourceRoot,
    targetRoot,
    execute,
    overwrite,
    migrateSecrets,
    outputDir,
    summary: buildSummary(items),
    items,
  };
  writeReport(result);
  return result;
}
