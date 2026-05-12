import {
  buildCanonicalSlashCommandDefinitions,
  type CanonicalSlashCommandDefinition,
} from '../../command-registry.js';
import { resolveTextChannelSlashCommands } from '../../gateway/text-channel-commands.js';
import { normalizeTrimmedString } from '../../utils/normalized-strings.js';
import { isRecord } from '../../utils/type-guards.js';

export interface SlackManifestSlashCommand {
  command: string;
  description: string;
  should_escape: boolean;
  usage_hint?: string;
}

export interface SlackSlashCommandManifestFragment {
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  features: {
    slash_commands: SlackManifestSlashCommand[];
  };
}

export type SlackSlashCommandManifestFormat = 'yaml' | 'json';

const SLACK_NATIVE_COMMAND_PREFIX = 'hc-';
const SLACK_LEGACY_COMMAND_PREFIXES = ['hybridclaw-'] as const;

function normalizeCanonicalCommandName(value: string): string {
  return value.trim().toLowerCase();
}

function buildSlackManifestCommandName(commandName: string): string {
  return `/${SLACK_NATIVE_COMMAND_PREFIX}${normalizeCanonicalCommandName(commandName)}`;
}

function buildSlackLegacyCommandName(commandName: string): string {
  return `/${normalizeCanonicalCommandName(commandName)}`;
}

function buildSlackLegacyPrefixedCommandNames(commandName: string): string[] {
  const normalized = normalizeCanonicalCommandName(commandName);
  return SLACK_LEGACY_COMMAND_PREFIXES.map(
    (prefix) => `/${prefix}${normalized}`,
  );
}

function buildSlackManifestSlashCommand(
  definition: CanonicalSlashCommandDefinition,
): SlackManifestSlashCommand {
  const usageHint =
    normalizeTrimmedString(definition.tuiMenuEntries?.[0]?.label) ||
    normalizeTrimmedString(definition.tuiMenu?.label) ||
    undefined;

  return {
    command: buildSlackManifestCommandName(definition.name),
    description: definition.description.trim(),
    should_escape: false,
    ...(usageHint ? { usage_hint: usageHint } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeManifestCommandName(value: unknown): string {
  return normalizeTrimmedString(value).toLowerCase();
}

function dedupeSlackManifestSlashCommands(
  commands: SlackManifestSlashCommand[],
): SlackManifestSlashCommand[] {
  const seen = new Set<string>();
  const deduped: SlackManifestSlashCommand[] = [];
  for (const command of commands) {
    const normalized = normalizeManifestCommandName(command.command);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push({ ...command });
  }
  return deduped;
}

const SLACK_NATIVE_SLASH_COMMAND_DEFINITIONS = dedupeSlackManifestSlashCommands(
  buildCanonicalSlashCommandDefinitions([]).map(buildSlackManifestSlashCommand),
);

const SLACK_NATIVE_MANIFEST_COMMAND_NAMES =
  SLACK_NATIVE_SLASH_COMMAND_DEFINITIONS.map((definition) =>
    definition.command.slice(1),
  ).filter(Boolean);

const SLACK_LEGACY_SLASH_COMMAND_NAMES = buildCanonicalSlashCommandDefinitions(
  [],
)
  .flatMap((definition) => [
    normalizeCanonicalCommandName(definition.name),
    ...SLACK_LEGACY_COMMAND_PREFIXES.map(
      (prefix) => `${prefix}${normalizeCanonicalCommandName(definition.name)}`,
    ),
  ])
  .filter(Boolean);

const SLACK_NATIVE_SLASH_COMMAND_NAMES = [
  ...new Set([
    ...SLACK_NATIVE_MANIFEST_COMMAND_NAMES,
    ...SLACK_LEGACY_SLASH_COMMAND_NAMES,
  ]),
];

const SLACK_NATIVE_SLASH_COMMAND_SET = new Set(
  SLACK_NATIVE_SLASH_COMMAND_NAMES,
);

const SLACK_REPLACED_MANIFEST_COMMAND_NAMES = new Set(
  buildCanonicalSlashCommandDefinitions([])
    .flatMap((definition) => [
      normalizeManifestCommandName(
        buildSlackManifestCommandName(definition.name),
      ),
      normalizeManifestCommandName(
        buildSlackLegacyCommandName(definition.name),
      ),
      ...buildSlackLegacyPrefixedCommandNames(definition.name).map(
        normalizeManifestCommandName,
      ),
    ])
    .filter(Boolean),
);

export function buildSlackSlashCommandDefinitions(): SlackManifestSlashCommand[] {
  return SLACK_NATIVE_SLASH_COMMAND_DEFINITIONS.map((definition) => ({
    ...definition,
  }));
}

export function getSlackNativeSlashCommandNames(): string[] {
  return [...SLACK_NATIVE_SLASH_COMMAND_NAMES];
}

export function buildSlackSlashCommandManifestFragment(): SlackSlashCommandManifestFragment {
  return {
    oauth_config: {
      scopes: {
        bot: ['commands'],
      },
    },
    features: {
      slash_commands: buildSlackSlashCommandDefinitions(),
    },
  };
}

export function mergeSlackSlashCommandsIntoManifest(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const oauthConfig = asRecord(manifest.oauth_config) || {};
  const scopes = asRecord(oauthConfig.scopes) || {};
  const botScopes = Array.isArray(scopes.bot)
    ? scopes.bot.map((value) => normalizeTrimmedString(value)).filter(Boolean)
    : [];
  const mergedBotScopes = [...botScopes];
  if (!mergedBotScopes.includes('commands')) {
    mergedBotScopes.push('commands');
  }

  const features = asRecord(manifest.features) || {};
  const existingSlashCommands = Array.isArray(features.slash_commands)
    ? features.slash_commands.map((entry) => asRecord(entry)).filter(isRecord)
    : [];
  const hybridClawCommands = new Set(
    SLACK_NATIVE_SLASH_COMMAND_DEFINITIONS.map((definition) =>
      normalizeManifestCommandName(definition.command),
    ),
  );
  const preservedSlashCommands = existingSlashCommands.filter((entry) => {
    const commandName = normalizeManifestCommandName(entry.command);
    return (
      commandName &&
      !hybridClawCommands.has(commandName) &&
      !SLACK_REPLACED_MANIFEST_COMMAND_NAMES.has(commandName)
    );
  });

  return {
    ...manifest,
    oauth_config: {
      ...oauthConfig,
      scopes: {
        ...scopes,
        bot: mergedBotScopes,
      },
    },
    features: {
      ...features,
      slash_commands: [
        ...preservedSlashCommands,
        ...buildSlackSlashCommandDefinitions(),
      ],
    },
  };
}

export function renderSlackSlashCommandManifest(
  format: SlackSlashCommandManifestFormat,
): string {
  const manifest = buildSlackSlashCommandManifestFragment();
  if (format === 'json') {
    return JSON.stringify(manifest, null, 2);
  }

  const lines = ['oauth_config:', '  scopes:', '    bot:'];
  for (const scope of manifest.oauth_config.scopes.bot) {
    lines.push(`      - ${JSON.stringify(scope)}`);
  }
  lines.push('features:', '  slash_commands:');
  for (const command of manifest.features.slash_commands) {
    lines.push(`    - command: ${JSON.stringify(command.command)}`);
    lines.push(`      description: ${JSON.stringify(command.description)}`);
    lines.push(
      `      should_escape: ${command.should_escape ? 'true' : 'false'}`,
    );
    if (command.usage_hint) {
      lines.push(`      usage_hint: ${JSON.stringify(command.usage_hint)}`);
    }
  }
  return lines.join('\n');
}

export function resolveSlackNativeSlashCommandArgs(params: {
  commandName: string;
  text?: string | null;
}): string[][] | null {
  const commandName = String(params.commandName || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase();
  if (!commandName || !SLACK_NATIVE_SLASH_COMMAND_SET.has(commandName)) {
    return null;
  }

  const canonicalCommandName = [
    SLACK_NATIVE_COMMAND_PREFIX,
    ...SLACK_LEGACY_COMMAND_PREFIXES,
  ].reduce(
    (value, prefix) =>
      value.startsWith(prefix) ? value.slice(prefix.length) : value,
    commandName,
  );
  const text = String(params.text || '').trim();
  const slashCommand = text
    ? `/${canonicalCommandName} ${text}`
    : `/${canonicalCommandName}`;
  return resolveTextChannelSlashCommands(slashCommand);
}
