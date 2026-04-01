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
  readStoredRuntimeSecrets,
  runtimeSecretsPath,
  saveRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { bootstrapRuntimeSecrets } from '../security/runtime-secrets-bootstrap.js';
import type { McpServerConfig } from '../types/models.js';

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
  agentId?: string;
  execute?: boolean;
  overwrite?: boolean;
  migrateSecrets?: boolean;
}

export interface AgentMigrationResult {
  sourceKind: AgentMigrationSource;
  sourceRoot: string;
  targetAgentId: string;
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

interface MergedWorkspaceSourceSet {
  sourcePaths: string[];
  sourceFiles: string[];
  sourceDirectories: string[];
}

interface SourceAdapter {
  readonly kind: AgentMigrationSource;
  readonly defaultRoot: string;
  load(sourceRoot: string): SourceSnapshot;
  resolveWorkspaceFile(sourceRoot: string, filename: string): string | null;
  listMergedWorkspaceSources?(
    sourceRoot: string,
  ): Partial<Record<'MEMORY.md' | 'USER.md', MergedWorkspaceSourceSet>>;
  listSkillRoots(sourceRoot: string): string[];
  extractModel(config: Record<string, unknown>): string;
  extractMcpServers(
    config: Record<string, unknown>,
  ): Record<string, McpServerConfig>;
  extractSecrets(
    snapshot: SourceSnapshot,
    sourceRoot: string,
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
  'TOOLS.md',
  'HEARTBEAT.md',
] as const;

const MERGED_WORKSPACE_FILES = ['MEMORY.md', 'USER.md'] as const;

const ENTRY_DELIMITER = '\n§\n';
const IMPORT_SECTION_MARKER = '<!-- hybridclaw-agent-migration -->';

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
  'BRAVE_API_KEY',
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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractMarkdownEntries(text: string): string[] {
  const entries: string[] = [];
  const headings: string[] = [];
  let paragraphLines: string[] = [];
  let inCodeBlock = false;

  const contextPrefix = (): string => {
    const filtered = headings.filter(
      (heading) =>
        heading &&
        !/\b(MEMORY|USER|SOUL|AGENTS|TOOLS|IDENTITY|HEARTBEAT)\.md\b/i.test(
          heading,
        ),
    );
    return filtered.join(' > ');
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const block = paragraphLines.join(' ').trim();
    paragraphLines = [];
    if (!block) return;
    const prefix = contextPrefix();
    entries.push(prefix ? `${prefix}: ${block}` : block);
  };

  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      flushParagraph();
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      while (headings.length >= level) headings.pop();
      headings.push(headingMatch[2].trim());
      continue;
    }

    const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*\S)\s*$/);
    if (bulletMatch) {
      flushParagraph();
      const content = bulletMatch[1].trim();
      const prefix = contextPrefix();
      entries.push(prefix ? `${prefix}: ${content}` : content);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph();
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeText(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(entry.trim());
  }
  return deduped;
}

function parseExistingMergedEntries(content: string): string[] {
  const markerIndex = content.indexOf(IMPORT_SECTION_MARKER);
  const target = markerIndex >= 0 ? content.slice(markerIndex) : content;
  const entries = target.includes(ENTRY_DELIMITER)
    ? target
        .split(ENTRY_DELIMITER)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : extractMarkdownEntries(target);
  return entries.filter(
    (entry) =>
      entry !== 'Imported migration entries will appear here.' &&
      entry !== 'Imported user notes will appear here.',
  );
}

function renderMergedWorkspaceContent(
  existingContent: string,
  heading: string,
  entries: string[],
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`## ${heading}`);
  lines.push('');
  lines.push(IMPORT_SECTION_MARKER);
  lines.push('');
  if (entries.length > 0) {
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
  } else {
    lines.push(
      `- ${heading === 'Imported User Notes' ? 'Imported user notes will appear here.' : 'Imported migration entries will appear here.'}`,
    );
  }
  const suffix = lines.join('\n');
  const markerIndex = existingContent.indexOf('\n---\n\n## ');
  const baseContent =
    markerIndex >= 0 &&
    existingContent.includes(IMPORT_SECTION_MARKER, markerIndex)
      ? existingContent.slice(0, markerIndex).trimEnd()
      : existingContent.trimEnd();
  return `${baseContent}${suffix}\n`;
}

function mergeWorkspaceEntries(params: {
  sourcePaths: string[];
  sourceFiles: string[];
  sourceDirectories: string[];
  destinationPath: string;
  execute: boolean;
  overwrite: boolean;
  backupRoot: string | null;
  replaceTemplate: boolean;
  kind: string;
  heading: string;
}): MigrationItem | null {
  const sourcePaths = params.sourcePaths.filter((sourcePath) =>
    fs.existsSync(sourcePath),
  );
  if (sourcePaths.length === 0) {
    return null;
  }

  const incomingEntries = sourcePaths.flatMap((sourcePath) =>
    extractMarkdownEntries(readTextFile(sourcePath)),
  );
  const summarizedSource =
    params.sourceDirectories.length === 0 && params.sourceFiles.length === 1
      ? params.sourceFiles[0] || null
      : params.sourceFiles.length === 0 && params.sourceDirectories.length === 1
        ? params.sourceDirectories[0] || null
        : null;
  if (incomingEntries.length === 0) {
    return makeItem(
      params.kind,
      summarizedSource,
      params.destinationPath,
      'skipped',
      'No importable entries found',
      {
        sourceFiles: params.sourceFiles,
        sourceDirectories: params.sourceDirectories,
      },
    );
  }

  const existingContent = fs.existsSync(params.destinationPath)
    ? readTextFile(params.destinationPath)
    : '';
  const existingEntries =
    !existingContent || params.replaceTemplate
      ? []
      : parseExistingMergedEntries(existingContent);

  if (
    existingContent &&
    !params.replaceTemplate &&
    !params.overwrite &&
    !existingContent.includes(IMPORT_SECTION_MARKER)
  ) {
    return makeItem(
      params.kind,
      summarizedSource,
      params.destinationPath,
      'conflict',
      'Destination already customized',
      {
        sourceFiles: params.sourceFiles,
        sourceDirectories: params.sourceDirectories,
      },
    );
  }

  const merged = [...existingEntries];
  const seen = new Set(existingEntries.map((entry) => normalizeText(entry)));
  let addedEntries = 0;
  let duplicateEntries = 0;
  for (const entry of incomingEntries) {
    const normalized = normalizeText(entry);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      duplicateEntries += 1;
      continue;
    }
    seen.add(normalized);
    merged.push(entry);
    addedEntries += 1;
  }

  if (addedEntries === 0) {
    return makeItem(
      params.kind,
      summarizedSource,
      params.destinationPath,
      'skipped',
      'No new entries to import',
      {
        sourceFiles: params.sourceFiles,
        sourceDirectories: params.sourceDirectories,
        sourcePathCount: sourcePaths.length,
        existingEntries: existingEntries.length,
        duplicateEntries,
      },
    );
  }

  const nextContent = renderMergedWorkspaceContent(
    existingContent ||
      readTextFile(
        resolveInstallPath('templates', path.basename(params.destinationPath)),
      ),
    params.heading,
    merged,
  );

  let backupPath: string | null = null;
  if (params.execute) {
    ensureDir(path.dirname(params.destinationPath));
    if (params.backupRoot) {
      backupPath = backupTarget(params.destinationPath, params.backupRoot);
    }
    fs.writeFileSync(params.destinationPath, nextContent, 'utf-8');
  }

  return makeItem(
    params.kind,
    summarizedSource,
    params.destinationPath,
    'migrated',
    '',
    {
      sourceFiles: params.sourceFiles,
      sourceDirectories: params.sourceDirectories,
      sourcePathCount: sourcePaths.length,
      existingEntries: existingEntries.length,
      addedEntries,
      duplicateEntries,
      ...(backupPath ? { backup: backupPath } : {}),
      ...(params.execute ? {} : { dryRun: true }),
    },
  );
}

function parseAuthProfiles(
  sourceRoot: string,
): Record<string, Record<string, unknown>> {
  const raw = parseJsonFile(
    path.join(sourceRoot, 'agents', 'main', 'agent', 'auth-profiles.json'),
  );
  if (Object.keys(raw).length === 0) return {};
  const profiles = isRecord(raw.profiles) ? raw.profiles : raw;
  return Object.fromEntries(
    Object.entries(profiles).filter(([, value]) => isRecord(value)),
  ) as Record<string, Record<string, unknown>>;
}

function maybeReadNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function maybeReadBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

function maybeReadString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeOpenClawIdentityLinks(
  value: unknown,
): RuntimeConfig['sessionRouting']['identityLinks'] {
  if (!isRecord(value)) return {};
  const normalized: RuntimeConfig['sessionRouting']['identityLinks'] = {};
  for (const [identity, rawAliases] of Object.entries(value)) {
    const normalizedIdentity = maybeReadString(identity).toLowerCase();
    if (!normalizedIdentity || !Array.isArray(rawAliases)) continue;
    const aliases = normalizeStringArray(rawAliases).map((alias) =>
      alias.toLowerCase(),
    );
    if (aliases.length === 0) continue;
    normalized[normalizedIdentity] = aliases;
  }
  return normalized;
}

function mergeIdentityLinks(
  existing: RuntimeConfig['sessionRouting']['identityLinks'],
  incoming: RuntimeConfig['sessionRouting']['identityLinks'],
): RuntimeConfig['sessionRouting']['identityLinks'] {
  const merged = { ...existing };
  for (const [identity, aliases] of Object.entries(incoming)) {
    merged[identity] = mergeUniqueStrings(merged[identity] || [], aliases);
  }
  return merged;
}

function cloneIdentityLinks(
  value: RuntimeConfig['sessionRouting']['identityLinks'],
): RuntimeConfig['sessionRouting']['identityLinks'] {
  return Object.fromEntries(
    Object.entries(value).map(([identity, aliases]) => [
      identity,
      [...aliases],
    ]),
  );
}

function isSupportedWebSearchProvider(
  value: string,
): value is RuntimeConfig['web']['search']['provider'] {
  return ['auto', 'perplexity', 'tavily', 'duckduckgo', 'searxng'].includes(
    value,
  );
}

function applyOpenClawProviderConfig(
  draft: RuntimeConfig,
  snapshot: SourceSnapshot,
  overwrite: boolean,
): { imported: string[]; unmapped: string[] } {
  const models = isRecord(snapshot.config.models) ? snapshot.config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  const imported: string[] = [];
  const unmapped: string[] = [];

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) continue;
    const name = providerName.toLowerCase();
    const baseUrl = maybeReadString(providerConfig.baseUrl);
    const providerModels = normalizeStringArray(providerConfig.models);

    const applyModels = (targetModels: string[]) =>
      providerModels.length > 0
        ? mergeUniqueStrings(targetModels, providerModels)
        : targetModels;

    if (name.includes('hybridai')) {
      if (
        baseUrl &&
        (overwrite || draft.hybridai.baseUrl === 'https://hybridai.one')
      ) {
        draft.hybridai.baseUrl = baseUrl;
      }
      draft.hybridai.models = applyModels(draft.hybridai.models);
      imported.push(providerName);
      continue;
    }
    if (name.includes('codex') || name.includes('openai-codex')) {
      if (baseUrl && (overwrite || !draft.codex.baseUrl))
        draft.codex.baseUrl = baseUrl;
      draft.codex.models = applyModels(draft.codex.models);
      imported.push(providerName);
      continue;
    }
    if (name.includes('openrouter')) {
      draft.openrouter.enabled = true;
      if (
        baseUrl &&
        (overwrite ||
          draft.openrouter.baseUrl === 'https://openrouter.ai/api/v1')
      ) {
        draft.openrouter.baseUrl = baseUrl;
      }
      draft.openrouter.models = applyModels(draft.openrouter.models);
      imported.push(providerName);
      continue;
    }
    if (name.includes('mistral')) {
      draft.mistral.enabled = true;
      if (
        baseUrl &&
        (overwrite || draft.mistral.baseUrl === 'https://api.mistral.ai/v1')
      ) {
        draft.mistral.baseUrl = baseUrl;
      }
      draft.mistral.models = applyModels(draft.mistral.models);
      imported.push(providerName);
      continue;
    }
    if (name.includes('huggingface') || name === 'hf') {
      draft.huggingface.enabled = true;
      if (
        baseUrl &&
        (overwrite ||
          draft.huggingface.baseUrl === 'https://router.huggingface.co/v1')
      ) {
        draft.huggingface.baseUrl = baseUrl;
      }
      draft.huggingface.models = applyModels(draft.huggingface.models);
      imported.push(providerName);
      continue;
    }
    if (name.includes('ollama')) {
      draft.local.backends.ollama.enabled = true;
      if (
        baseUrl &&
        (overwrite ||
          draft.local.backends.ollama.baseUrl === 'http://127.0.0.1:11434')
      ) {
        draft.local.backends.ollama.baseUrl = baseUrl;
      }
      imported.push(providerName);
      continue;
    }
    if (name.includes('lmstudio') || name.includes('lm-studio')) {
      draft.local.backends.lmstudio.enabled = true;
      if (
        baseUrl &&
        (overwrite ||
          draft.local.backends.lmstudio.baseUrl === 'http://127.0.0.1:1234/v1')
      ) {
        draft.local.backends.lmstudio.baseUrl = baseUrl;
      }
      imported.push(providerName);
      continue;
    }
    if (name.includes('vllm')) {
      draft.local.backends.vllm.enabled = true;
      if (
        baseUrl &&
        (overwrite ||
          draft.local.backends.vllm.baseUrl === 'http://127.0.0.1:8000/v1')
      ) {
        draft.local.backends.vllm.baseUrl = baseUrl;
      }
      imported.push(providerName);
      continue;
    }
    if (
      baseUrl ||
      providerModels.length > 0 ||
      providerConfig.apiKey !== undefined
    ) {
      unmapped.push(providerName);
    }
  }

  return { imported, unmapped };
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
  bootstrapRuntimeSecrets();
  const storedSecrets = readStoredRuntimeSecrets();
  const secrets: Partial<Record<RuntimeSecretKey, string>> = {};
  for (const key of RUNTIME_SECRET_KEYS) {
    const value = storedSecrets[key]?.trim();
    if (value) secrets[key] = value;
  }
  return secrets;
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
  if (!fs.statSync(sourcePath).isFile()) {
    return makeItem(
      kind,
      sourcePath,
      destinationPath,
      'error',
      'Source is not a regular file',
    );
  }

  if (fs.existsSync(destinationPath)) {
    if (!fs.statSync(destinationPath).isFile()) {
      return makeItem(
        kind,
        sourcePath,
        destinationPath,
        'conflict',
        'Destination is not a regular file',
      );
    }
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
  if (params.execute) {
    ensureDir(params.targetRoot);
  }
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
  listMergedWorkspaceSources(sourceRoot) {
    const memoryFiles = [
      path.join(sourceRoot, 'workspace', 'MEMORY.md'),
      path.join(sourceRoot, 'workspace.default', 'MEMORY.md'),
    ].filter((candidate) => fs.existsSync(candidate));
    const memoryDirectories = [
      path.join(sourceRoot, 'workspace', 'memory'),
      path.join(sourceRoot, 'workspace.default', 'memory'),
    ].filter(
      (candidate) =>
        fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(),
    );
    return {
      'MEMORY.md': {
        sourceFiles: memoryFiles,
        sourceDirectories: memoryDirectories,
        sourcePaths: [
          ...memoryFiles,
          ...memoryDirectories.flatMap((candidate) =>
            fs
              .readdirSync(candidate)
              .filter((entry) => entry.endsWith('.md'))
              .sort()
              .map((entry) => path.join(candidate, entry)),
          ),
        ],
      },
      'USER.md': {
        sourceFiles: [
          path.join(sourceRoot, 'workspace', 'USER.md'),
          path.join(sourceRoot, 'workspace.default', 'USER.md'),
        ].filter((candidate) => fs.existsSync(candidate)),
        sourceDirectories: [],
        sourcePaths: [
          path.join(sourceRoot, 'workspace', 'USER.md'),
          path.join(sourceRoot, 'workspace.default', 'USER.md'),
        ].filter((candidate) => fs.existsSync(candidate)),
      },
    };
  },
  listSkillRoots(sourceRoot) {
    return [
      path.join(sourceRoot, 'workspace', 'skills'),
      path.join(sourceRoot, 'workspace', '.agents', 'skills'),
      path.join(sourceRoot, 'workspace.default', 'skills'),
      path.join(sourceRoot, 'workspace.default', '.agents', 'skills'),
      path.join(sourceRoot, 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
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
  extractSecrets(snapshot, sourceRoot) {
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
    const gateway = isRecord(snapshot.config.gateway)
      ? snapshot.config.gateway
      : {};
    const auth = isRecord(gateway.auth) ? gateway.auth : {};
    const gatewayToken = maybeReadString(auth.token);
    if (gatewayToken && !secrets.GATEWAY_API_TOKEN) {
      secrets.GATEWAY_API_TOKEN = gatewayToken;
    }

    const authProfiles = parseAuthProfiles(sourceRoot);
    for (const [profileName, profileData] of Object.entries(authProfiles)) {
      const apiKey =
        maybeReadString(profileData.key) || maybeReadString(profileData.apiKey);
      if (!apiKey) continue;
      const name = profileName.toLowerCase();
      if (name.includes('openrouter') && !secrets.OPENROUTER_API_KEY) {
        secrets.OPENROUTER_API_KEY = apiKey;
      } else if (
        (name.includes('huggingface') || name.includes('hf')) &&
        !secrets.HF_TOKEN
      ) {
        secrets.HF_TOKEN = apiKey;
      } else if (name.includes('mistral') && !secrets.MISTRAL_API_KEY) {
        secrets.MISTRAL_API_KEY = apiKey;
      } else if (
        (name.includes('openai') || name.includes('codex')) &&
        !secrets.OPENAI_API_KEY
      ) {
        secrets.OPENAI_API_KEY = apiKey;
      } else if (name.includes('hybridai') && !secrets.HYBRIDAI_API_KEY) {
        secrets.HYBRIDAI_API_KEY = apiKey;
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
            {
              current: { model: currentModel || '[unset]' },
              incoming: { model },
              keyMappings: {
                model: {
                  source: 'models.default | model',
                  target: 'hybridai.defaultModel',
                },
              },
            },
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
            {
              currentModel,
              incomingModel: model,
              keyMappings: {
                model: {
                  source: 'models.default | model',
                  target: 'hybridai.defaultModel',
                },
              },
            },
          ),
        );
      }
    }

    const channels = isRecord(snapshot.config.channels)
      ? snapshot.config.channels
      : {};
    const discord = isRecord(channels.discord) ? channels.discord : {};
    const whatsapp = isRecord(channels.whatsapp) ? channels.whatsapp : {};
    const gateway = isRecord(snapshot.config.gateway)
      ? snapshot.config.gateway
      : {};
    const gatewayAuth = isRecord(gateway.auth) ? gateway.auth : {};
    const tools = isRecord(snapshot.config.tools) ? snapshot.config.tools : {};
    const toolsWeb = isRecord(tools.web)
      ? tools.web
      : isRecord(tools.webSearch)
        ? tools.webSearch
        : {};
    const search = isRecord(toolsWeb.search) ? toolsWeb.search : toolsWeb;
    const session = isRecord(snapshot.config.session)
      ? snapshot.config.session
      : {};
    const logging = isRecord(snapshot.config.logging)
      ? snapshot.config.logging
      : {};
    const skills = isRecord(snapshot.config.skills)
      ? snapshot.config.skills
      : {};
    const defaults = isRecord(snapshot.config.agents)
      ? isRecord(snapshot.config.agents.defaults)
        ? snapshot.config.agents.defaults
        : {}
      : {};
    const providerMigration = applyOpenClawProviderConfig(
      draft,
      snapshot,
      overwrite,
    );
    if (providerMigration.imported.length > 0) {
      addItem(
        makeItem(
          'config:providers',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          { providers: providerMigration.imported },
        ),
      );
    }
    if (providerMigration.unmapped.length > 0) {
      addItem(
        makeItem(
          'config:providers',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'skipped',
          'No direct HybridClaw provider mapping',
          { providers: providerMigration.unmapped },
        ),
      );
    }

    const enableRag = maybeReadBoolean(defaults.enableRag);
    if (enableRag !== null) {
      const currentEnableRag = draft.agents.defaults?.enableRag;
      draft.hybridai.enableRag = enableRag;
      draft.agents.defaults = {
        ...draft.agents.defaults,
        enableRag,
      };
      addItem(
        makeItem(
          'config:agent-behavior',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: { enableRag: currentEnableRag },
            incoming: { enableRag },
            keyMappings: {
              enableRag: {
                source: 'agents.defaults.enableRag',
                target: 'agents.defaults.enableRag',
              },
            },
          },
        ),
      );
    }

    const gatewayBaseUrl =
      maybeReadString(gateway.baseUrl) ||
      maybeReadString(gateway.url) ||
      maybeReadString(gateway.origin);
    const currentGatewayBaseUrl = draft.ops.gatewayBaseUrl;
    const currentWebApiToken = draft.ops.webApiToken;
    if (gatewayBaseUrl) {
      draft.ops.gatewayBaseUrl = gatewayBaseUrl;
    }
    const webApiToken = maybeReadString(gatewayAuth.webApiToken);
    if (webApiToken) {
      draft.ops.webApiToken = webApiToken;
    }
    if (gatewayBaseUrl || webApiToken) {
      addItem(
        makeItem(
          'config:gateway',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: {
              gatewayBaseUrl: currentGatewayBaseUrl || '[unset]',
              webApiToken: currentWebApiToken ? '[set]' : '[unset]',
            },
            incoming: {
              ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}),
              ...(webApiToken ? { webApiToken: '[set]' } : {}),
            },
            keyMappings: {
              gatewayBaseUrl: {
                source: 'gateway.baseUrl | gateway.url | gateway.origin',
                target: 'ops.gatewayBaseUrl',
              },
              webApiToken: {
                source: 'gateway.auth.webApiToken',
                target: 'ops.webApiToken',
              },
            },
          },
        ),
      );
    }

    const searchProvider = maybeReadString(search.provider).toLowerCase();
    const currentSearchProvider = draft.web.search.provider;
    const currentSearchDefaultCount = draft.web.search.defaultCount;
    const currentSearchCacheTtlMinutes = draft.web.search.cacheTtlMinutes;
    const webSearchDetails: Record<string, unknown> = {};
    if (isSupportedWebSearchProvider(searchProvider)) {
      draft.web.search.provider = searchProvider;
      webSearchDetails.provider = searchProvider;
    }
    const searchMaxResults = maybeReadNumber(search.maxResults);
    if (searchMaxResults !== null) {
      draft.web.search.defaultCount = clampInteger(searchMaxResults, 1, 10);
      webSearchDetails.defaultCount = draft.web.search.defaultCount;
    }
    const searchCacheTtlMinutes = maybeReadNumber(search.cacheTtlMinutes);
    if (searchCacheTtlMinutes !== null) {
      draft.web.search.cacheTtlMinutes = Math.max(
        0,
        Math.round(searchCacheTtlMinutes),
      );
      webSearchDetails.cacheTtlMinutes = draft.web.search.cacheTtlMinutes;
    }
    if (Object.keys(webSearchDetails).length > 0) {
      addItem(
        makeItem(
          'config:web-search',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            ...webSearchDetails,
            current: {
              provider: currentSearchProvider,
              defaultCount: currentSearchDefaultCount,
              cacheTtlMinutes: currentSearchCacheTtlMinutes,
            },
            incoming: webSearchDetails,
            keyMappings: {
              provider: {
                source: 'tools.web.search.provider',
                target: 'web.search.provider',
              },
              defaultCount: {
                source: 'tools.web.search.maxResults',
                target: 'web.search.defaultCount',
              },
              cacheTtlMinutes: {
                source: 'tools.web.search.cacheTtlMinutes',
                target: 'web.search.cacheTtlMinutes',
              },
            },
          },
        ),
      );
    }

    const logLevel = maybeReadString(
      logging.level || logging.logLevel,
    ).toLowerCase();
    if (
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(
        logLevel,
      )
    ) {
      const currentLogLevel = draft.ops.logLevel;
      draft.ops.logLevel = logLevel as RuntimeConfig['ops']['logLevel'];
      addItem(
        makeItem(
          'config:logging',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: { logLevel: currentLogLevel },
            incoming: { logLevel },
            keyMappings: {
              logLevel: {
                source: 'logging.level | logging.logLevel',
                target: 'ops.logLevel',
              },
            },
          },
        ),
      );
    }

    const prefix =
      typeof discord.prefix === 'string' ? discord.prefix.trim() : '';
    const discordChanges: Record<string, unknown> = {};
    const currentDiscord = {
      prefix: draft.discord.prefix,
      textChunkLimit: draft.discord.textChunkLimit,
      presenceIntent: draft.discord.presenceIntent,
      guildMembersIntent: draft.discord.guildMembersIntent,
    };
    if (prefix && (draft.discord.prefix === '!claw' || overwrite)) {
      draft.discord.prefix = prefix;
      discordChanges.prefix = prefix;
    }
    const discordTextChunkLimit = maybeReadNumber(discord.textChunkLimit);
    if (discordTextChunkLimit !== null) {
      draft.discord.textChunkLimit = Math.max(
        1,
        Math.round(discordTextChunkLimit),
      );
      discordChanges.textChunkLimit = draft.discord.textChunkLimit;
    }
    const discordIntents = isRecord(discord.intents) ? discord.intents : {};
    const presenceIntent = maybeReadBoolean(discordIntents.presence);
    if (presenceIntent !== null) {
      draft.discord.presenceIntent = presenceIntent;
      discordChanges.presenceIntent = presenceIntent;
    }
    const guildMembersIntent = maybeReadBoolean(discordIntents.guildMembers);
    if (guildMembersIntent !== null) {
      draft.discord.guildMembersIntent = guildMembersIntent;
      discordChanges.guildMembersIntent = guildMembersIntent;
    }
    if (Object.keys(discordChanges).length > 0) {
      addItem(
        makeItem(
          'config:discord',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: currentDiscord,
            incoming: discordChanges,
            keyMappings: {
              prefix: {
                source: 'channels.discord.prefix',
                target: 'discord.prefix',
              },
              textChunkLimit: {
                source: 'channels.discord.textChunkLimit',
                target: 'discord.textChunkLimit',
              },
              presenceIntent: {
                source: 'channels.discord.intents.presence',
                target: 'discord.presenceIntent',
              },
              guildMembersIntent: {
                source: 'channels.discord.intents.guildMembers',
                target: 'discord.guildMembersIntent',
              },
            },
          },
        ),
      );
    }

    const allowWhatsApp = normalizeStringArray(whatsapp.allowFrom);
    if (allowWhatsApp.length > 0) {
      const currentAllowFrom = [...draft.whatsapp.allowFrom];
      draft.whatsapp.allowFrom = mergeUniqueStrings(
        draft.whatsapp.allowFrom,
        allowWhatsApp,
      );
      addItem(
        makeItem(
          'config:whatsapp',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: { allowFrom: currentAllowFrom },
            incoming: { allowFrom: draft.whatsapp.allowFrom },
            keyMappings: {
              allowFrom: {
                source: 'channels.whatsapp.allowFrom',
                target: 'whatsapp.allowFrom',
              },
            },
          },
        ),
      );
    }

    const sessionRoutingChanges: Record<string, unknown> = {};
    const currentSessionRouting = {
      dmScope: draft.sessionRouting.dmScope,
      identityLinks: cloneIdentityLinks(draft.sessionRouting.identityLinks),
    };
    const sessionDmScope = maybeReadString(session.dmScope).toLowerCase();
    if (
      sessionDmScope === 'per-channel-peer' &&
      draft.sessionRouting.dmScope !== 'per-channel-peer'
    ) {
      draft.sessionRouting.dmScope = 'per-channel-peer';
      sessionRoutingChanges.dmScope = 'per-channel-peer';
    }
    const identityLinks = normalizeOpenClawIdentityLinks(session.identityLinks);
    if (Object.keys(identityLinks).length > 0) {
      const mergedIdentityLinks = mergeIdentityLinks(
        draft.sessionRouting.identityLinks,
        identityLinks,
      );
      if (
        JSON.stringify(mergedIdentityLinks) !==
        JSON.stringify(draft.sessionRouting.identityLinks)
      ) {
        draft.sessionRouting.identityLinks = mergedIdentityLinks;
        sessionRoutingChanges.identityLinks = mergedIdentityLinks;
      }
    }
    if (Object.keys(sessionRoutingChanges).length > 0) {
      addItem(
        makeItem(
          'config:session-routing',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: currentSessionRouting,
            incoming: sessionRoutingChanges,
            keyMappings: {
              dmScope: {
                source: 'session.dmScope',
                target: 'sessionRouting.dmScope',
              },
              identityLinks: {
                source: 'session.identityLinks',
                target: 'sessionRouting.identityLinks',
              },
            },
          },
        ),
      );
    }

    const skillsChanges: Record<string, unknown> = {};
    const skillLoad = isRecord(skills.load) ? skills.load : {};
    const extraSkillDirs = normalizeStringArray(skillLoad.extraDirs);
    const currentExtraDirs = [...draft.skills.extraDirs];
    if (extraSkillDirs.length > 0) {
      draft.skills.extraDirs = mergeUniqueStrings(
        draft.skills.extraDirs,
        extraSkillDirs,
      );
      skillsChanges.extraDirs = extraSkillDirs.length;
    }
    if (Object.keys(skillsChanges).length > 0) {
      addItem(
        makeItem(
          'config:skills',
          path.join(sourceRoot, 'openclaw.json'),
          runtimeConfigPath(),
          'migrated',
          '',
          {
            current: { extraDirs: currentExtraDirs },
            incoming: { extraDirs: draft.skills.extraDirs },
            keyMappings: {
              extraDirs: {
                source: 'skills.load.extraDirs',
                target: 'skills.extraDirs',
              },
            },
          },
        ),
      );
    }
  },
  archiveCandidates(sourceRoot) {
    return [
      path.join(sourceRoot, 'openclaw.json'),
      path.join(sourceRoot, 'exec-approvals.json'),
      path.join(sourceRoot, 'cron'),
      path.join(sourceRoot, 'workspace', '.learnings'),
      path.join(sourceRoot, 'workspace', 'hooks'),
      path.join(sourceRoot, 'workspace.default', 'hooks'),
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
  listMergedWorkspaceSources(sourceRoot) {
    return {
      'MEMORY.md': {
        sourceFiles: [path.join(sourceRoot, 'MEMORY.md')].filter((candidate) =>
          fs.existsSync(candidate),
        ),
        sourceDirectories: [],
        sourcePaths: [path.join(sourceRoot, 'MEMORY.md')].filter((candidate) =>
          fs.existsSync(candidate),
        ),
      },
      'USER.md': {
        sourceFiles: [path.join(sourceRoot, 'USER.md')].filter((candidate) =>
          fs.existsSync(candidate),
        ),
        sourceDirectories: [],
        sourcePaths: [path.join(sourceRoot, 'USER.md')].filter((candidate) =>
          fs.existsSync(candidate),
        ),
      },
    };
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
  extractSecrets(snapshot, _sourceRoot) {
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
          {
            current: { model: currentModel || '[unset]' },
            incoming: { model },
            keyMappings: {
              model: {
                source: 'model',
                target: 'hybridai.defaultModel',
              },
            },
          },
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
        {
          currentModel,
          incomingModel: model,
          keyMappings: {
            model: {
              source: 'model',
              target: 'hybridai.defaultModel',
            },
          },
        },
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

function normalizeTargetAgentId(agentId: string | undefined): string {
  return String(agentId || '').trim() || DEFAULT_AGENT_ID;
}

function ensureConfiguredAgent(
  draft: RuntimeConfig,
  agentId: string,
  overwrite: boolean,
): void {
  draft.agents ??= {};
  const nextAgents = Array.isArray(draft.agents.list)
    ? [...draft.agents.list]
    : [];
  const existingIndex = nextAgents.findIndex(
    (entry) => String(entry?.id || '').trim() === agentId,
  );
  if (existingIndex >= 0) {
    if (overwrite) {
      nextAgents[existingIndex] = {
        ...nextAgents[existingIndex],
        id: agentId,
      };
    }
  } else {
    nextAgents.push({ id: agentId });
  }
  draft.agents.list = nextAgents;
}

async function syncImportedAgentRegistry(): Promise<void> {
  const [{ initAgentRegistry }, { initDatabase, isDatabaseInitialized }] =
    await Promise.all([
      import('../agents/agent-registry.js'),
      import('../memory/db.js'),
    ]);
  if (!isDatabaseInitialized()) {
    initDatabase({ quiet: true });
  }
  initAgentRegistry(getRuntimeConfig().agents);
}

export async function migrateAgentHome(
  options: AgentMigrationOptions,
): Promise<AgentMigrationResult> {
  const adapter = getAdapter(options.sourceKind);
  const sourceRoot = path.resolve(options.sourceRoot || adapter.defaultRoot);
  const targetAgentId = normalizeTargetAgentId(options.agentId);
  const execute = options.execute !== false;
  const overwrite = options.overwrite === true;
  const migrateSecrets = options.migrateSecrets === true;
  const targetRoot = path.dirname(runtimeConfigPath());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const migrationRoot = path.join(
    targetRoot,
    'migration',
    options.sourceKind,
    timestamp,
  );
  const outputDir = execute ? migrationRoot : null;
  const backupRoot = outputDir ? path.join(outputDir, 'backups') : null;
  const archiveRoot = path.join(migrationRoot, 'archive');
  const items: MigrationItem[] = [];
  const addItem = (item: MigrationItem) => {
    items.push(item);
  };

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    const result: AgentMigrationResult = {
      sourceKind: options.sourceKind,
      sourceRoot,
      targetAgentId,
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
  const workspaceRoot = agentWorkspaceDir(targetAgentId);

  for (const filename of WORKSPACE_FILES) {
    const sourcePath = adapter.resolveWorkspaceFile(sourceRoot, filename);
    if (!sourcePath) continue;
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

  const mergedWorkspaceSources =
    adapter.listMergedWorkspaceSources?.(sourceRoot);
  for (const filename of MERGED_WORKSPACE_FILES) {
    const mergedSources = mergedWorkspaceSources?.[filename] || {
      sourcePaths: [],
      sourceFiles: [],
      sourceDirectories: [],
    };
    const item = mergeWorkspaceEntries({
      sourcePaths: mergedSources.sourcePaths,
      sourceFiles: mergedSources.sourceFiles,
      sourceDirectories: mergedSources.sourceDirectories,
      destinationPath: path.join(workspaceRoot, filename),
      execute,
      overwrite,
      backupRoot,
      replaceTemplate: maybeTemplateReplacement(
        path.join(workspaceRoot, filename),
      ),
      kind: 'workspace-file',
      heading:
        filename === 'MEMORY.md'
          ? 'Imported Migration Entries'
          : 'Imported User Notes',
    });
    if (item) addItem(item);
  }

  if (migrateSecrets) {
    const incomingSecrets = adapter.extractSecrets(snapshot, sourceRoot);
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
      const skippedReason =
        skippedKeys.length > 0
          ? 'Secrets already up to date'
          : 'No compatible secrets found';
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
            : skippedReason,
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
  const hasConfiguredTargetAgent = (existingConfig.agents.list || []).some(
    (entry) => String(entry?.id || '').trim() === targetAgentId,
  );
  const existingMcpKeys = new Set(Object.keys(existingConfig.mcpServers));
  const incomingMcpServers = adapter.extractMcpServers(snapshot.config);
  const shouldApplyConfigChanges =
    Object.keys(incomingMcpServers).length > 0 ||
    Object.keys(snapshot.config).length > 0 ||
    !hasConfiguredTargetAgent;
  if (shouldApplyConfigChanges) {
    if (execute && backupRoot) {
      backupTarget(runtimeConfigPath(), backupRoot);
    }
    const applyConfigChanges = (draft: RuntimeConfig) => {
      ensureConfiguredAgent(draft, targetAgentId, overwrite);
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
      await syncImportedAgentRegistry();
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
    if (!hasConfiguredTargetAgent) {
      addItem(
        makeItem(
          'config:agent',
          sourceRoot,
          runtimeConfigPath(),
          'migrated',
          '',
          { agentId: targetAgentId, ...(execute ? {} : { dryRun: true }) },
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
    targetAgentId,
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
