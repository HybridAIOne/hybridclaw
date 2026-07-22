import type { AdminConfig } from '../api/types';
import {
  GENERATED_SETTINGS_REGISTRY,
  type GeneratedSettingEntry,
  type GeneratedSettingKind,
} from '../generated/settings-registry';
import {
  ADMIN_CONFIG_SECTION_OWNERS,
  type AdminConfigSectionOwner,
} from './admin-config-owners';

export interface SettingsRegistryEntry extends GeneratedSettingEntry {
  label: string;
  description: string;
  owner?: AdminConfigSectionOwner;
}

export interface SettingsRegistrySection {
  id: string;
  label: string;
  description: string;
  owner?: AdminConfigSectionOwner;
  entries: ReadonlyArray<SettingsRegistryEntry>;
}

const PROVIDERS_OWNER: AdminConfigSectionOwner = {
  label: 'Providers',
  to: '/admin/models',
};

const SECTION_OWNERS: Readonly<
  Partial<Record<string, AdminConfigSectionOwner>>
> = {
  ...ADMIN_CONFIG_SECTION_OWNERS,
  agents: { label: 'Agents', to: '/admin/agents' },
  skills: { label: 'Skills', to: '/admin/skills' },
  tools: { label: 'Extensions', to: '/admin/extensions?tab=tools' },
  plugins: { label: 'Extensions', to: '/admin/extensions?tab=plugins' },
  adaptiveSkills: {
    label: 'Harness Evolution',
    to: '/admin/harness-evolution',
  },
  deployment: { label: 'Gateway', to: '/admin/gateway' },
  hybridai: PROVIDERS_OWNER,
  codex: PROVIDERS_OWNER,
  openai: PROVIDERS_OWNER,
  anthropic: PROVIDERS_OWNER,
  openrouter: PROVIDERS_OWNER,
  mistral: PROVIDERS_OWNER,
  huggingface: PROVIDERS_OWNER,
  gemini: PROVIDERS_OWNER,
  deepseek: PROVIDERS_OWNER,
  xai: PROVIDERS_OWNER,
  zai: PROVIDERS_OWNER,
  kimi: PROVIDERS_OWNER,
  minimax: PROVIDERS_OWNER,
  dashscope: PROVIDERS_OWNER,
  xiaomi: PROVIDERS_OWNER,
  kilo: PROVIDERS_OWNER,
  local: PROVIDERS_OWNER,
  auxiliaryModels: PROVIDERS_OWNER,
  routing: PROVIDERS_OWNER,
};

const FIELD_OWNERS: Readonly<Record<string, AdminConfigSectionOwner>> = {
  'ops.logLevel': { label: 'Logs', to: '/admin/logs' },
  'ops.logRequests': { label: 'Logs', to: '/admin/logs' },
  'ops.debugModelResponses': { label: 'Logs', to: '/admin/logs' },
};

const SECTION_ORDER = [
  'ops',
  'security',
  'container',
  'browser',
  'memory',
  'sessionCompaction',
  'sessionReset',
  'sessionRouting',
  'promptHooks',
  'proactive',
  'heartbeat',
  'web',
  'media',
  'observability',
  'audit',
  'ui',
  'deployment',
  'agents',
  'skills',
  'tools',
  'plugins',
  'adaptiveSkills',
  'channelInstructions',
  'discord',
  'discordWebhook',
  'msteams',
  'slack',
  'slackWebhook',
  'telegram',
  'signal',
  'threema',
  'whatsapp',
  'line',
  'voice',
  'imessage',
  'email',
  'hybridai',
  'codex',
  'openai',
  'anthropic',
  'openrouter',
  'mistral',
  'huggingface',
  'gemini',
  'deepseek',
  'xai',
  'zai',
  'kimi',
  'minimax',
  'dashscope',
  'xiaomi',
  'kilo',
  'local',
  'auxiliaryModels',
  'routing',
  'mcpServers',
  'version',
] as const;

const SECTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ops: 'Gateway process, API, database, and diagnostics.',
  security: 'Runtime security and sensitive-output controls.',
  container: 'Sandbox resources, networking, and worker behavior.',
  browser: 'Browser providers and browser execution defaults.',
  memory: 'Recall, embeddings, consolidation, and ranking.',
  sessionCompaction: 'Conversation compaction thresholds and safeguards.',
  sessionReset: 'Automatic conversation reset policies.',
  sessionRouting: 'Conversation identity and direct-message scoping.',
  promptHooks: 'Prompt layers applied to agent turns.',
  proactive: 'Active hours, delegation, retries, and long-running work.',
  heartbeat: 'Periodic heartbeat delivery.',
  web: 'Web search providers and caching.',
  media: 'Audio and media processing.',
  observability: 'Telemetry export and batching.',
  audit: 'Audit payload retention.',
  ui: 'Console navigation and presentation.',
};

const SECTION_LABELS: Readonly<Record<string, string>> = {
  hybridai: 'HybridAI',
  openai: 'OpenAI',
  xai: 'xAI',
  zai: 'Z.AI',
  minimax: 'MiniMax',
  msteams: 'Microsoft Teams',
  imessage: 'iMessage',
  ui: 'UI',
  mcpServers: 'MCP Servers',
};

const ACRONYMS: Readonly<Record<string, string>> = {
  api: 'API',
  cpu: 'CPU',
  db: 'DB',
  id: 'ID',
  mcp: 'MCP',
  rag: 'RAG',
  rss: 'RSS',
  tts: 'TTS',
  ui: 'UI',
  url: 'URL',
};

function humanize(value: string): string {
  const words = value
    .replace(/_/gu, ' ')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(' ');
  return words
    .map(
      (word) =>
        ACRONYMS[word] ?? word.replace(/^./u, (letter) => letter.toUpperCase()),
    )
    .join(' ')
    .replace(/^./u, (letter) => letter.toUpperCase());
}

function fieldDescription(entry: GeneratedSettingEntry): string {
  const defaultValue = entry.defaultValue;
  if (entry.kind === 'list' || entry.kind === 'object') {
    return `Structured value at ${entry.path}.`;
  }
  if (
    defaultValue === '' ||
    (typeof defaultValue === 'string' &&
      defaultValue.startsWith('/tmp/hybridclaw-runtime-home/'))
  ) {
    return `Runtime value at ${entry.path}.`;
  }
  return `Runtime value at ${entry.path}. Default: ${String(defaultValue)}.`;
}

export function settingsOwnerForPath(
  path: string,
): AdminConfigSectionOwner | undefined {
  return FIELD_OWNERS[path] ?? SECTION_OWNERS[path.split('.')[0] ?? ''];
}

export const SETTINGS_REGISTRY: ReadonlyArray<SettingsRegistryEntry> =
  GENERATED_SETTINGS_REGISTRY.map((entry) => ({
    ...entry,
    label: humanize(entry.path.split('.').at(-1) ?? entry.path),
    description: fieldDescription(entry),
    owner: settingsOwnerForPath(entry.path),
  }));

export const SETTINGS_REGISTRY_SECTIONS: ReadonlyArray<SettingsRegistrySection> =
  (() => {
    const grouped = new Map<string, SettingsRegistryEntry[]>();
    for (const entry of SETTINGS_REGISTRY) {
      const entries = grouped.get(entry.section) ?? [];
      entries.push(entry);
      grouped.set(entry.section, entries);
    }

    return [...grouped.entries()]
      .map(([id, entries]) => {
        const owner = SECTION_OWNERS[id];
        const label = SECTION_LABELS[id] ?? humanize(id);
        return {
          id,
          label,
          description:
            SECTION_DESCRIPTIONS[id] ??
            (owner
              ? `Managed on the ${owner.label} page.`
              : `Runtime settings for ${label.toLowerCase()}.`),
          owner,
          entries,
        };
      })
      .sort((left, right) => {
        const leftIndex = SECTION_ORDER.indexOf(
          left.id as (typeof SECTION_ORDER)[number],
        );
        const rightIndex = SECTION_ORDER.indexOf(
          right.id as (typeof SECTION_ORDER)[number],
        );
        if (leftIndex === -1 && rightIndex === -1) {
          return left.label.localeCompare(right.label);
        }
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
      });
  })();

export function settingValue(config: AdminConfig, path: string): unknown {
  let current: unknown = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function withSettingValue(
  config: AdminConfig,
  path: string,
  value: unknown,
): AdminConfig {
  const clone = structuredClone(config) as Record<string, unknown>;
  const parts = path.split('.');
  let current = clone;
  for (const segment of parts.slice(0, -1)) {
    const child = current[segment];
    if (child === null || typeof child !== 'object' || Array.isArray(child)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const final = parts.at(-1);
  if (final) current[final] = value;
  return clone as AdminConfig;
}

export function isSettingValuePresent(
  config: AdminConfig,
  entry: SettingsRegistryEntry,
): boolean {
  return settingValue(config, entry.path) !== undefined;
}

export function settingsSearchText(
  entry: Pick<SettingsRegistryEntry, 'label' | 'path' | 'description'>,
): string {
  return `${entry.label} ${entry.path} ${entry.description}`.toLowerCase();
}

export function settingAnchor(path: string): string {
  return `setting-${path.replace(/[^a-z0-9]+/giu, '-')}`;
}

export function settingKindForValue(
  value: unknown,
  fallback: GeneratedSettingKind,
): GeneratedSettingKind {
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return fallback;
}
