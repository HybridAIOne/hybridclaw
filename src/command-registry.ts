import { APPROVE_COMMAND_USAGE } from './approval-commands.js';
import { findLoadedPluginCommand } from './plugins/plugin-manager.js';

export interface CanonicalTuiMenuPresentation {
  label?: string;
  insertText?: string;
  aliases?: string[];
}

export interface CanonicalTuiMenuEntryDefinition {
  id: string;
  label: string;
  insertText: string;
  description: string;
  aliases?: string[];
  depth?: number;
}

export type LocalSessionSurface = 'tui' | 'web';

export interface LocalSessionSlashHelpEntry {
  command: string;
  description: string;
}

export interface CanonicalSlashCommandDefinition {
  name: string;
  description: string;
  options?: CanonicalSlashCommandOptionDefinition[];
  tuiMenu?: CanonicalTuiMenuPresentation;
  tuiMenuEntries?: CanonicalTuiMenuEntryDefinition[];
  tuiOnly?: boolean;
  localSurfaces?: LocalSessionSurface[];
}

export type CanonicalSlashStringOptionDefinition = {
  kind: 'string';
  name: string;
  description: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string }>;
};

export type CanonicalSlashSubcommandOptionDefinition = {
  kind: 'subcommand';
  name: string;
  description: string;
  options?: CanonicalSlashStringOptionDefinition[];
  tuiMenu?: CanonicalTuiMenuPresentation;
  tuiMenuEntries?: CanonicalTuiMenuEntryDefinition[];
};

export type CanonicalSlashCommandOptionDefinition =
  | CanonicalSlashStringOptionDefinition
  | CanonicalSlashSubcommandOptionDefinition;

export interface CanonicalSlashInteractionInput {
  commandName: string;
  getString: (name: string, required?: boolean) => string | null;
  getSubcommand: () => string | null;
}

export interface PluginSlashCommandCatalogEntry {
  name: string;
  description?: string;
}

interface LocalSessionHelpPresentation {
  command?: string;
  description?: string;
  surfaces?: LocalSessionSurface[];
  commandBySurface?: Partial<Record<LocalSessionSurface, string>>;
}

const REGISTERED_TEXT_COMMAND_NAMES = new Set([
  'agent',
  'auth',
  'bot',
  'config',
  'policy',
  'dream',
  'secret',
  'concierge',
  'rag',
  'model',
  'status',
  'memory',
  'show',
  'approve',
  'usage',
  'export',
  'sessions',
  'audit',
  'schedule',
  'eval',
  'channel',
  'ralph',
  'mcp',
  'plugin',
  'voice',
  'clear',
  'reset',
  'compact',
  'help',
]);

const APPROVAL_ACTION_CHOICES = [
  { name: 'view', value: 'view' },
  { name: 'yes', value: 'yes' },
  { name: 'session', value: 'session' },
  { name: 'agent', value: 'agent' },
  { name: 'all', value: 'all' },
  { name: 'no', value: 'no' },
] satisfies Array<{ name: string; value: string }>;

const CHANNEL_MODE_CHOICES = [
  { name: 'off', value: 'off' },
  { name: 'mention', value: 'mention' },
  { name: 'free', value: 'free' },
] satisfies Array<{ name: string; value: string }>;

const CHANNEL_POLICY_CHOICES = [
  { name: 'open', value: 'open' },
  { name: 'allowlist', value: 'allowlist' },
  { name: 'disabled', value: 'disabled' },
] satisfies Array<{ name: string; value: string }>;

const RAG_MODE_CHOICES = [
  { name: 'on', value: 'on' },
  { name: 'off', value: 'off' },
] satisfies Array<{ name: string; value: string }>;

const RESET_CONFIRM_CHOICES = [
  { name: 'yes', value: 'yes' },
  { name: 'no', value: 'no' },
] satisfies Array<{ name: string; value: string }>;

const USAGE_VIEW_CHOICES = [
  { name: 'summary', value: 'summary' },
  { name: 'daily', value: 'daily' },
  { name: 'monthly', value: 'monthly' },
  { name: 'model', value: 'model' },
] satisfies Array<{ name: string; value: string }>;

const USAGE_WINDOW_CHOICES = [
  { name: 'daily', value: 'daily' },
  { name: 'monthly', value: 'monthly' },
] satisfies Array<{ name: string; value: string }>;

const MODEL_PROVIDER_CHOICES = [
  { name: 'hybridai', value: 'hybridai' },
  { name: 'codex', value: 'codex' },
  { name: 'openrouter', value: 'openrouter' },
  { name: 'huggingface', value: 'huggingface' },
  { name: 'local', value: 'local' },
  { name: 'ollama', value: 'ollama' },
  { name: 'lmstudio', value: 'lmstudio' },
  { name: 'llamacpp', value: 'llamacpp' },
  { name: 'vllm', value: 'vllm' },
] satisfies Array<{ name: string; value: string }>;

const CONCIERGE_PROFILE_CHOICES = [
  { name: 'asap', value: 'asap' },
  { name: 'balanced', value: 'balanced' },
  { name: 'no_hurry', value: 'no_hurry' },
] satisfies Array<{ name: string; value: string }>;

const LOCAL_SESSION_HELP_PRESENTATIONS: Record<
  string,
  LocalSessionHelpPresentation
> = {
  agent: {
    command: '/agent [info|list|switch|create|model] [id] [--model <model>]',
    description: 'Inspect or manage agents',
  },
  approve: {
    command: APPROVE_COMMAND_USAGE,
    description: 'View/respond to pending approvals',
  },
  audit: {
    command: '/audit [sessionId]',
    description: 'Show recent structured audit events',
  },
  auth: {
    command: '/auth status <provider>',
    description: 'Show local provider auth and config status',
  },
  bot: {
    command: '/bot [info|list|set <id|name>|clear]',
    description: 'Manage the chatbot for this session',
  },
  concierge: {
    command:
      '/concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]',
    description: 'Configure concierge routing',
  },
  config: {
    command: '/config [check|reload|set <key> <value>]',
    description: 'Show or update local runtime config',
  },
  policy: {
    command: '/policy [status|list|allow|deny|delete|preset|default|reset]',
    description: 'Inspect or update workspace HTTP/network policy',
  },
  export: {
    command: '/export session [sessionId] | /export trace [sessionId|all]',
    description: 'Export session snapshot or trace JSONL',
  },
  fullauto: {
    command: '/fullauto [status|off|on [prompt]|prompt]',
    description: 'Enable or inspect session full-auto mode',
  },
  help: {
    command: '/help',
    description: 'Show this help',
  },
  info: {
    command: '/info',
    description: 'Show current settings',
  },
  mcp: {
    command: '/mcp [list|add|toggle|remove|reconnect] [name] [json]',
    description: 'Manage MCP servers',
  },
  model: {
    command:
      '/model [<name>|info|list [provider]|set <name>|clear|default [name]]',
    description: 'Inspect or set session/default model',
  },
  memory: {
    command: '/memory inspect [sessionId] | /memory query <query>',
    description:
      'Inspect memory layers or preview prompt-time memory attachment',
  },
  plugin: {
    command:
      '/plugin [list|enable|disable|config|install|reinstall|reload|uninstall]',
    description: 'Manage installed plugins',
  },
  ralph: {
    command: '/ralph [info|on|off|set n]',
    description: 'Configure Ralph loop',
  },
  schedule: {
    command: '/schedule add "<cron>" <prompt>',
    description: 'Add a scheduled task',
  },
  secret: {
    command: '/secret [list|set|show|unset|route]',
    description: 'Manage stored secrets and URL auth routes',
  },
  voice: {
    command: '/voice [info|call <e164-number>]',
    description: 'Inspect voice status or place an outbound Twilio call',
  },
  skill: {
    command:
      '/skill config|list|enable <name> [--channel <kind>]|disable <name> [--channel <kind>]|inspect <name>|inspect --all|runs <name>|install <skill> <dependency>|learn <name> [--apply|--reject|--rollback]|history <name>|sync [--skip-skill-scan] <source>|import [--force] [--skip-skill-scan] <source>',
    description:
      'Manage skill config, dependencies, health, runs, amendments, and imports',
  },
  usage: {
    command: '/usage [summary|daily|monthly|model [daily|monthly] [agentId]]',
    description: 'Show usage',
  },
};

function tokenizeFreeformText(value: string): string[] {
  return value.match(/"[^"]*"|\S+/g) ?? [];
}

function isAvailableOnLocalSurface(
  definition: CanonicalSlashCommandDefinition,
  surface: LocalSessionSurface,
): boolean {
  return (
    !definition.localSurfaces || definition.localSurfaces.includes(surface)
  );
}

function compareCommandLabels(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeStringOption(
  interaction: CanonicalSlashInteractionInput,
  name: string,
  required = false,
): string | null {
  const value = interaction.getString(name, required)?.trim() ?? '';
  return value || null;
}

function normalizeSubcommand(
  interaction: CanonicalSlashInteractionInput,
): string | null {
  return interaction.getSubcommand()?.trim().toLowerCase() || null;
}

export function isRegisteredTextCommandName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return (
    REGISTERED_TEXT_COMMAND_NAMES.has(normalized) ||
    findLoadedPluginCommand(normalized) !== undefined
  );
}

function hasDynamicTextCommandName(
  name: string,
  dynamicTextCommands?: Iterable<string>,
): boolean {
  if (!dynamicTextCommands) return false;
  for (const entry of dynamicTextCommands) {
    if (
      String(entry || '')
        .trim()
        .toLowerCase() === name
    ) {
      return true;
    }
  }
  return false;
}

export function mapCanonicalCommandToGatewayArgs(
  parts: string[],
  options?: {
    dynamicTextCommands?: Iterable<string>;
  },
): string[] | null {
  const cmd = (parts[0] || '').trim().toLowerCase();
  if (!cmd) return null;

  switch (cmd) {
    case 'bot': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'info') return ['bot', 'info'];
      if (sub === 'list') return ['bot', 'list'];
      if (sub === 'clear' || sub === 'auto') return ['bot', 'clear'];
      if (sub === 'set') return ['bot', 'set', ...parts.slice(2)];
      return ['bot', 'set', ...parts.slice(1)];
    }

    case 'model': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'select') return ['model', 'info'];
      if (sub === 'info') return ['model', 'info'];
      if (sub === 'list') return ['model', 'list', ...parts.slice(2)];
      if (sub === 'clear' || sub === 'auto') return ['model', 'clear'];
      if (sub === 'default') {
        return parts.length > 2
          ? ['model', 'default', ...parts.slice(2)]
          : ['model', 'default'];
      }
      if (sub === 'set') return ['model', 'set', ...parts.slice(2)];
      if (parts.length > 1) return ['model', 'set', ...parts.slice(1)];
      return null;
    }

    case 'concierge': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (
        !sub ||
        sub === 'info' ||
        sub === 'on' ||
        sub === 'off' ||
        sub === 'enable' ||
        sub === 'disable'
      ) {
        return sub ? ['concierge', sub] : ['concierge', 'info'];
      }
      if (sub === 'model') {
        return parts.length > 2
          ? ['concierge', 'model', ...parts.slice(2)]
          : ['concierge', 'model'];
      }
      if (sub === 'profile') {
        return parts.length > 2
          ? ['concierge', 'profile', ...parts.slice(2)]
          : ['concierge', 'profile'];
      }
      return ['concierge', ...parts.slice(1)];
    }

    case 'agent': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'info') return ['agent'];
      if (sub === 'list') return ['agent', 'list'];
      if (sub === 'switch') return ['agent', 'switch', ...parts.slice(2)];
      if (sub === 'model') return ['agent', 'model', ...parts.slice(2)];
      if (sub === 'create') {
        const agentId = (parts[2] || '').trim();
        if (!agentId) return ['agent', 'create'];
        if ((parts[3] || '').trim().toLowerCase() === '--model') {
          return ['agent', 'create', agentId, ...parts.slice(3)];
        }
        if (parts.length === 4) {
          return ['agent', 'create', agentId, '--model', parts[3]];
        }
        return ['agent', 'create', ...parts.slice(2)];
      }
      return ['agent', ...parts.slice(1)];
    }

    case 'status':
      return ['status'];

    case 'memory': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub) return ['memory', 'inspect'];
      if (sub === 'inspect') return ['memory', 'inspect', ...parts.slice(2)];
      if (sub === 'query') return ['memory', 'query', ...parts.slice(2)];
      return ['memory', 'inspect', ...parts.slice(1)];
    }

    case 'auth': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub) return ['auth'];
      if (sub === 'status') {
        const provider = (parts[2] || '').trim().toLowerCase();
        return provider ? ['auth', 'status', provider] : ['auth', 'status'];
      }
      return ['auth', ...parts.slice(1)];
    }

    case 'show':
      return parts.length > 1 ? ['show', ...parts.slice(1)] : ['show'];

    case 'channel-mode':
      return ['channel', 'mode', ...parts.slice(1)];

    case 'channel-policy':
      return ['channel', 'policy', ...parts.slice(1)];

    case 'rag':
      return parts.length > 1 ? ['rag', parts[1]] : ['rag'];

    case 'ralph':
      return parts.length > 1
        ? ['ralph', ...parts.slice(1)]
        : ['ralph', 'info'];

    case 'mcp':
      return parts.length > 1 ? ['mcp', ...parts.slice(1)] : ['mcp', 'list'];

    case 'plugin': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'list') return ['plugin', 'list'];
      if (sub === 'enable' || sub === 'disable') {
        const pluginId = (parts[2] || '').trim();
        return pluginId ? ['plugin', sub, pluginId] : ['plugin', sub];
      }
      if (sub === 'config') {
        const pluginId = (parts[2] || '').trim();
        const key = (parts[3] || '').trim();
        const value = parts.slice(4).join(' ').trim();
        if (!pluginId) return ['plugin', 'config'];
        if (!key) return ['plugin', 'config', pluginId];
        if (!value) return ['plugin', 'config', pluginId, key];
        return ['plugin', 'config', pluginId, key, value];
      }
      if (sub === 'install') {
        const yes = (parts[parts.length - 1] || '').trim();
        const hasYes = yes === '--yes';
        const source = parts
          .slice(2, hasYes ? -1 : undefined)
          .join(' ')
          .trim();
        return source
          ? ['plugin', 'install', source, ...(hasYes ? ['--yes'] : [])]
          : ['plugin', 'install'];
      }
      if (sub === 'reinstall') {
        const yes = (parts[parts.length - 1] || '').trim();
        const hasYes = yes === '--yes';
        const source = parts
          .slice(2, hasYes ? -1 : undefined)
          .join(' ')
          .trim();
        return source
          ? ['plugin', 'reinstall', source, ...(hasYes ? ['--yes'] : [])]
          : ['plugin', 'reinstall'];
      }
      if (sub === 'check') {
        const pluginId = (parts[2] || '').trim();
        return pluginId ? ['plugin', 'check', pluginId] : ['plugin', 'check'];
      }
      if (sub === 'reload') return ['plugin', 'reload'];
      if (sub === 'uninstall') {
        const pluginId = (parts[2] || '').trim();
        return pluginId
          ? ['plugin', 'uninstall', pluginId]
          : ['plugin', 'uninstall'];
      }
      return null;
    }

    case 'config': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub) return ['config'];
      if (sub === 'check') return ['config', 'check'];
      if (sub === 'reload') return ['config', 'reload'];
      if (sub === 'set') {
        const key = (parts[2] || '').trim();
        const value = parts.slice(3).join(' ').trim();
        if (!key) return ['config', 'set'];
        if (!value) return ['config', 'set', key];
        return ['config', 'set', key, value];
      }
      return null;
    }

    case 'policy': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'status') return ['policy'];
      return ['policy', ...parts.slice(1)];
    }

    case 'secret':
      return parts.length > 1 ? ['secret', ...parts.slice(1)] : ['secret'];

    case 'voice': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'info' || sub === 'status') {
        return ['voice', 'info'];
      }
      if (sub === 'call') {
        return parts.length > 2
          ? ['voice', 'call', ...parts.slice(2)]
          : ['voice', 'call'];
      }
      return null;
    }

    case 'fullauto':
      return parts.length > 1 ? ['fullauto', ...parts.slice(1)] : ['fullauto'];

    case 'dream': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub) return ['dream'];
      if (sub === 'on' || sub === 'off' || sub === 'now' || sub === 'status') {
        return ['dream', sub];
      }
      return ['dream', ...parts.slice(1)];
    }

    case 'compact':
      return ['compact'];

    case 'clear':
      return ['clear'];

    case 'reset':
      return parts.length > 1 ? ['reset', ...parts.slice(1)] : ['reset'];

    case 'usage':
      return ['usage', ...parts.slice(1)];

    case 'export': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub) return ['export', 'session'];
      if (sub === 'session') return ['export', 'session', ...parts.slice(2)];
      if (sub === 'trace') return ['export', 'trace', ...parts.slice(2)];
      return ['export', 'session', ...parts.slice(1)];
    }

    case 'sessions':
      return ['sessions'];

    case 'audit':
      return ['audit', ...parts.slice(1)];

    case 'schedule':
      return ['schedule', ...parts.slice(1)];

    case 'eval':
      return ['eval', ...parts.slice(1)];

    case 'stop':
    case 'abort':
      return ['stop'];

    case 'help':
    case 'h':
      return ['help'];

    default:
      return findLoadedPluginCommand(cmd) ||
        hasDynamicTextCommandName(cmd, options?.dynamicTextCommands)
        ? [cmd, ...parts.slice(1)]
        : null;
  }
}

function buildSlashCommandCatalogDefinitions(
  modelChoices: Array<{ name: string; value: string }>,
): CanonicalSlashCommandDefinition[] {
  return [
    {
      name: 'status',
      description: 'Show HybridClaw runtime status (only visible to you)',
    },
    {
      name: 'memory',
      description:
        'Inspect memory layers or preview prompt-time memory attachment',
      localSurfaces: ['tui', 'web'],
      tuiMenuEntries: [
        {
          id: 'memory.inspect',
          label: '/memory inspect [sessionId]',
          insertText: '/memory inspect ',
          description: 'Inspect the built-in memory layers for a session',
        },
        {
          id: 'memory.query',
          label: '/memory query <query>',
          insertText: '/memory query ',
          description:
            'Preview the exact memory block the current session would attach',
        },
      ],
    },
    {
      name: 'show',
      description:
        'Control visible thinking and tool activity for this session',
      options: [
        {
          kind: 'subcommand',
          name: 'all',
          description: 'Show thinking and tool activity',
        },
        {
          kind: 'subcommand',
          name: 'thinking',
          description: 'Show thinking only',
        },
        {
          kind: 'subcommand',
          name: 'tools',
          description: 'Show tool activity only',
        },
        {
          kind: 'subcommand',
          name: 'none',
          description: 'Hide thinking and tool activity',
        },
      ],
    },
    {
      name: 'approve',
      description: 'View/respond to pending tool approval requests (private)',
      tuiMenuEntries: [
        {
          id: 'approve.view',
          label: '/approve view [approval_id]',
          insertText: '/approve view ',
          description:
            'Show the latest pending approval prompt, or a specific request id',
        },
        {
          id: 'approve.yes',
          label: '/approve yes [approval_id]',
          insertText: '/approve yes',
          description: 'Approve the pending request once',
        },
        {
          id: 'approve.session',
          label: '/approve session [approval_id]',
          insertText: '/approve session',
          description:
            'Approve the pending request for the rest of the session',
        },
        {
          id: 'approve.agent',
          label: '/approve agent [approval_id]',
          insertText: '/approve agent',
          description:
            'Approve the pending request for the current agent workspace',
        },
        {
          id: 'approve.all',
          label: '/approve all [approval_id]',
          insertText: '/approve all',
          description:
            'Approve the pending request for the workspace allowlist',
        },
        {
          id: 'approve.no',
          label: '/approve no [approval_id]',
          insertText: '/approve no',
          description: 'Deny or skip the pending approval request',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'action',
          description: 'Action to perform',
          choices: APPROVAL_ACTION_CHOICES,
        },
        {
          kind: 'string',
          name: 'approval_id',
          description: 'Optional approval id (defaults to latest pending)',
        },
      ],
    },
    {
      name: 'compact',
      description: 'Archive older session history and compact it into memory',
    },
    {
      name: 'dream',
      description: 'Control nightly memory consolidation and run it on demand',
      tuiOnly: true,
      tuiMenuEntries: [
        {
          id: 'dream.now',
          label: '/dream now',
          insertText: '/dream now',
          description: 'Run memory consolidation across agent workspaces now',
        },
        {
          id: 'dream.on',
          label: '/dream on',
          insertText: '/dream on',
          description: 'Enable nightly dream consolidation',
        },
        {
          id: 'dream.off',
          label: '/dream off',
          insertText: '/dream off',
          description: 'Disable nightly dream consolidation',
        },
      ],
      options: [
        {
          kind: 'subcommand',
          name: 'now',
          description: 'Run memory consolidation across agent workspaces now',
        },
        {
          kind: 'subcommand',
          name: 'on',
          description: 'Enable nightly dream consolidation',
        },
        {
          kind: 'subcommand',
          name: 'off',
          description: 'Disable nightly dream consolidation',
        },
      ],
    },
    {
      name: 'channel-mode',
      description: 'Set this channel to off, mention-only, or free-response',
      tuiMenuEntries: [
        {
          id: 'channel-mode.off',
          label: '/channel-mode off',
          insertText: '/channel-mode off',
          description: 'Disable channel replies until explicitly invoked',
        },
        {
          id: 'channel-mode.mention',
          label: '/channel-mode mention',
          insertText: '/channel-mode mention',
          description: 'Reply only when the assistant is mentioned',
        },
        {
          id: 'channel-mode.free',
          label: '/channel-mode free',
          insertText: '/channel-mode free',
          description: 'Allow free-response mode in the current channel',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'mode',
          description: 'Response mode for this channel',
          required: true,
          choices: CHANNEL_MODE_CHOICES,
        },
      ],
    },
    {
      name: 'channel-policy',
      description: 'Set guild channel policy to open, allowlist, or disabled',
      tuiMenuEntries: [
        {
          id: 'channel-policy.open',
          label: '/channel-policy open',
          insertText: '/channel-policy open',
          description: 'Allow the bot in all channels in the guild',
        },
        {
          id: 'channel-policy.allowlist',
          label: '/channel-policy allowlist',
          insertText: '/channel-policy allowlist',
          description: 'Restrict the bot to approved channels only',
        },
        {
          id: 'channel-policy.disabled',
          label: '/channel-policy disabled',
          insertText: '/channel-policy disabled',
          description: 'Disable guild-wide channel access',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'policy',
          description: 'Guild channel policy',
          required: true,
          choices: CHANNEL_POLICY_CHOICES,
        },
      ],
    },
    {
      name: 'model',
      description: 'Inspect or set session/default runtime models',
      tuiMenuEntries: [
        {
          id: 'model.select',
          label: '/model select',
          insertText: '/model select',
          description: 'Open the interactive model selector for this session',
        },
      ],
      options: [
        {
          kind: 'subcommand',
          name: 'info',
          description:
            'Show effective, session, agent, and default model scopes',
        },
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List available runtime models',
          options: [
            {
              kind: 'string',
              name: 'provider',
              description: 'Optional provider filter',
              choices: MODEL_PROVIDER_CHOICES,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'set',
          description: 'Set the model for this session',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Model name',
              required: true,
              choices: modelChoices.length > 0 ? modelChoices : undefined,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'clear',
          description: 'Clear the session model override',
          tuiMenu: {
            aliases: ['auto'],
          },
        },
        {
          kind: 'subcommand',
          name: 'default',
          description: 'Show or set the default model for new sessions',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Model name',
              choices: modelChoices.length > 0 ? modelChoices : undefined,
            },
          ],
        },
      ],
    },
    {
      name: 'concierge',
      description: 'Inspect or configure concierge routing defaults',
      options: [
        {
          kind: 'subcommand',
          name: 'info',
          description:
            'Show concierge enablement, decision model, and profile mappings',
        },
        {
          kind: 'subcommand',
          name: 'on',
          description: 'Enable concierge routing globally',
        },
        {
          kind: 'subcommand',
          name: 'off',
          description: 'Disable concierge routing globally',
        },
        {
          kind: 'subcommand',
          name: 'model',
          description: 'Show or set the concierge decision model',
          tuiMenu: {
            insertText: '/concierge model ',
          },
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Concierge decision model name',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'profile',
          description: 'Show or set a concierge execution profile model',
          tuiMenu: {
            insertText: '/concierge profile ',
          },
          options: [
            {
              kind: 'string',
              name: 'profile',
              description: 'Profile to inspect or change',
              required: true,
              choices: CONCIERGE_PROFILE_CHOICES,
            },
            {
              kind: 'string',
              name: 'model',
              description: 'Execution model mapped to that profile',
            },
          ],
        },
      ],
    },
    {
      name: 'agent',
      description:
        'Inspect, list, switch, create, install, or configure agents',
      options: [
        {
          kind: 'subcommand',
          name: 'info',
          description: 'Show the current session agent',
        },
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List available agents',
        },
        {
          kind: 'subcommand',
          name: 'switch',
          description: 'Switch this session to another agent',
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Existing agent id',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'create',
          description: 'Create a new agent',
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'New agent id',
              required: true,
            },
            {
              kind: 'string',
              name: 'model',
              description: 'Optional model name',
              choices: modelChoices.length > 0 ? modelChoices : undefined,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'install',
          description: 'Install a packaged agent from a path or URL',
          tuiMenu: {
            label: '/agent install <source>',
            insertText: '/agent install ',
            aliases: [
              '/agent install <source> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]',
            ],
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description:
                'Archive path, direct .claw URL, official:<agent-dir>, or github:owner/repo/<agent-dir>',
              required: true,
            },
            {
              kind: 'string',
              name: 'id',
              description: 'Optional installed agent id',
            },
            {
              kind: 'string',
              name: 'force',
              description: 'Optional --force override to replace an agent',
              choices: [{ name: '--force', value: '--force' }],
            },
            {
              kind: 'string',
              name: 'skip-skill-scan',
              description:
                'Optional --skip-skill-scan override to bypass the scanner',
              choices: [
                { name: '--skip-skill-scan', value: '--skip-skill-scan' },
              ],
            },
            {
              kind: 'string',
              name: 'skip-externals',
              description:
                'Optional --skip-externals override to skip imported skills',
              choices: [
                { name: '--skip-externals', value: '--skip-externals' },
              ],
            },
            {
              kind: 'string',
              name: 'skip-import-errors',
              description:
                'Optional --skip-import-errors override to continue after imported skill failures',
              choices: [
                {
                  name: '--skip-import-errors',
                  value: '--skip-import-errors',
                },
              ],
            },
            {
              kind: 'string',
              name: 'yes',
              description: 'Optional --yes override for non-interactive parity',
              choices: [{ name: '--yes', value: '--yes' }],
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'model',
          description: 'Show or set the current agent model',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Persistent model for the current agent',
              choices: modelChoices.length > 0 ? modelChoices : undefined,
            },
          ],
        },
      ],
    },
    {
      name: 'help',
      description: 'Show available HybridClaw commands',
      tuiMenu: {
        aliases: ['h'],
      },
    },
    {
      name: 'auth',
      description: 'Show local provider auth and config status',
      tuiOnly: true,
      options: [
        {
          kind: 'subcommand',
          name: 'status',
          description: 'Show local HybridAI auth status',
          tuiMenu: {
            label: '/auth status hybridai',
            insertText: '/auth status hybridai',
          },
          options: [
            {
              kind: 'string',
              name: 'provider',
              description: 'Provider name',
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'config',
      description:
        'Show, validate, reload, or set the local runtime config file',
      tuiOnly: true,
      tuiMenuEntries: [
        {
          id: 'config.set',
          label: '/config set <key> <value>',
          insertText: '/config set ',
          description: 'Set one runtime config value',
        },
        {
          id: 'config.check',
          label: '/config check',
          insertText: '/config check',
          description: 'Validate the current runtime config',
        },
        {
          id: 'config.reload',
          label: '/config reload',
          insertText: '/config reload',
          description: 'Hot-reload the current runtime config from disk',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'action',
          description: 'Optional action',
          choices: [
            { name: 'check', value: 'check' },
            { name: 'reload', value: 'reload' },
            { name: 'set', value: 'set' },
          ],
        },
        {
          kind: 'string',
          name: 'key',
          description: 'Dotted runtime config key path',
        },
        {
          kind: 'string',
          name: 'value',
          description: 'JSON value or plain string',
        },
      ],
    },
    {
      name: 'policy',
      description: 'Inspect or update workspace HTTP/network access policy',
      tuiOnly: true,
      localSurfaces: ['tui', 'web'],
      tuiMenuEntries: [
        {
          id: 'policy.status',
          label: '/policy',
          insertText: '/policy',
          description:
            'Show the current default stance, rule count, and presets',
        },
        {
          id: 'policy.list',
          label: '/policy list',
          insertText: '/policy list',
          description: 'List current workspace policy rules',
        },
        {
          id: 'policy.allow',
          label: '/policy allow <host>',
          insertText: '/policy allow ',
          description: 'Add an allow rule for one host or host glob',
        },
        {
          id: 'policy.preset.list',
          label: '/policy preset list',
          insertText: '/policy preset list',
          description: 'List bundled network policy presets',
        },
      ],
      options: [
        {
          kind: 'subcommand',
          name: 'status',
          description: 'Show the current default stance and preset summary',
        },
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List current workspace policy rules',
          options: [
            {
              kind: 'string',
              name: 'agent',
              description: 'Optional agent filter',
            },
            {
              kind: 'string',
              name: 'json',
              description: 'Optional --json flag',
              choices: [{ name: '--json', value: '--json' }],
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'allow',
          description: 'Add an allow rule',
          options: [
            {
              kind: 'string',
              name: 'host',
              description: 'Host or host glob',
              required: true,
            },
            {
              kind: 'string',
              name: 'agent',
              description: 'Optional agent id',
            },
            {
              kind: 'string',
              name: 'methods',
              description: 'Comma-separated HTTP methods',
            },
            {
              kind: 'string',
              name: 'paths',
              description: 'Comma-separated URL path globs',
            },
            {
              kind: 'string',
              name: 'port',
              description: 'Optional port number',
            },
            {
              kind: 'string',
              name: 'comment',
              description: 'Optional human-readable note',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'deny',
          description: 'Add a deny rule',
          options: [
            {
              kind: 'string',
              name: 'host',
              description: 'Host or host glob',
              required: true,
            },
            {
              kind: 'string',
              name: 'agent',
              description: 'Optional agent id',
            },
            {
              kind: 'string',
              name: 'methods',
              description: 'Comma-separated HTTP methods',
            },
            {
              kind: 'string',
              name: 'paths',
              description: 'Comma-separated URL path globs',
            },
            {
              kind: 'string',
              name: 'port',
              description: 'Optional port number',
            },
            {
              kind: 'string',
              name: 'comment',
              description: 'Optional human-readable note',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'delete',
          description: 'Delete one rule by list index or host',
          options: [
            {
              kind: 'string',
              name: 'target',
              description: 'Rule index or host pattern',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'reset',
          description: 'Reset workspace policy to the default network rules',
        },
        {
          kind: 'subcommand',
          name: 'default',
          description: 'Set the default allow or deny stance',
          options: [
            {
              kind: 'string',
              name: 'mode',
              description: 'Default network stance',
              required: true,
              choices: [
                { name: 'allow', value: 'allow' },
                { name: 'deny', value: 'deny' },
              ],
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'preset',
          description: 'List, apply, or remove bundled network presets',
          options: [
            {
              kind: 'string',
              name: 'action',
              description: 'Preset action',
              choices: [
                { name: 'list', value: 'list' },
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' },
              ],
            },
            {
              kind: 'string',
              name: 'name',
              description: 'Preset name',
            },
            {
              kind: 'string',
              name: 'dry-run',
              description: 'Optional --dry-run flag for preset add',
              choices: [{ name: '--dry-run', value: '--dry-run' }],
            },
          ],
        },
      ],
    },
    {
      name: 'secret',
      description:
        'Manage encrypted local secrets and URL-based HTTP auth injection',
      tuiOnly: true,
      tuiMenuEntries: [
        {
          id: 'secret.list',
          label: '/secret list',
          insertText: '/secret list',
          description: 'List stored secret names and HTTP auth routes',
        },
        {
          id: 'secret.set',
          label: '/secret set <name> <value>',
          insertText: '/secret set ',
          description: 'Store an encrypted named secret',
        },
        {
          id: 'secret.route.add',
          label: '/secret route add <url-prefix> <secret-name>',
          insertText: '/secret route add ',
          description: 'Auto-attach a stored secret to matching HTTP requests',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'action',
          description: 'Secret command action',
          choices: [
            { name: 'list', value: 'list' },
            { name: 'set', value: 'set' },
            { name: 'unset', value: 'unset' },
            { name: 'show', value: 'show' },
            { name: 'route', value: 'route' },
          ],
        },
        {
          kind: 'string',
          name: 'name',
          description: 'Secret name or route subcommand',
        },
        {
          kind: 'string',
          name: 'value',
          description:
            'Secret value, URL prefix, or additional route arguments',
        },
      ],
    },
    {
      name: 'voice',
      description: 'Inspect voice status or place an outbound Twilio call',
      tuiOnly: true,
      tuiMenuEntries: [
        {
          id: 'voice.info',
          label: '/voice info',
          insertText: '/voice info',
          description: 'Show current voice config and webhook status',
        },
        {
          id: 'voice.call',
          label: '/voice call <e164-number>',
          insertText: '/voice call ',
          description:
            'Place an outbound call through the configured Twilio number',
        },
      ],
      options: [
        {
          kind: 'subcommand',
          name: 'info',
          description: 'Show current voice config and webhook status',
        },
        {
          kind: 'subcommand',
          name: 'call',
          description:
            'Place an outbound call through the configured Twilio number',
          options: [
            {
              kind: 'string',
              name: 'number',
              description: 'Destination phone number in E.164 format',
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'plugin',
      description:
        'List, configure, enable, disable, install, reinstall, reload, or uninstall HybridClaw plugins',
      options: [
        {
          kind: 'subcommand',
          name: 'list',
          description:
            'List discovered plugins, descriptions, commands, tools, hooks, and load errors',
        },
        {
          kind: 'subcommand',
          name: 'enable',
          description: 'Enable a discovered plugin',
          tuiMenu: {
            label: '/plugin enable <id>',
            insertText: '/plugin enable ',
          },
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Plugin id',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'disable',
          description: 'Disable a discovered plugin',
          tuiMenu: {
            label: '/plugin disable <id>',
            insertText: '/plugin disable ',
          },
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Plugin id',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'config',
          description: 'Show or set a top-level plugins.list[] config override',
          tuiMenu: {
            label: '/plugin config <id> [key] [value|--unset]',
            insertText: '/plugin config ',
          },
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Plugin id',
              required: true,
            },
            {
              kind: 'string',
              name: 'key',
              description: 'Top-level plugin config key',
            },
            {
              kind: 'string',
              name: 'value',
              description: 'Config value or --unset',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'install',
          description: 'Install a plugin from a local TUI/web session',
          tuiMenu: {
            label: '/plugin install <path|plugin-id|npm-spec>',
            insertText: '/plugin install ',
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description:
                'Local plugin path, repo-local plugin id, or npm package spec',
              required: true,
            },
            {
              kind: 'string',
              name: 'yes',
              description:
                'Optional --yes override to approve dependency installs',
              choices: [{ name: '--yes', value: '--yes' }],
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'reinstall',
          description:
            'Replace an installed plugin from a local TUI/web session',
          tuiMenu: {
            label: '/plugin reinstall <path|plugin-id|npm-spec>',
            insertText: '/plugin reinstall ',
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description:
                'Local plugin path, repo-local plugin id, or npm package spec',
              required: true,
            },
            {
              kind: 'string',
              name: 'yes',
              description:
                'Optional --yes override to approve dependency installs',
              choices: [{ name: '--yes', value: '--yes' }],
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'check',
          description:
            'Check dependency, env, and binary status for one plugin',
          tuiMenu: {
            label: '/plugin check <plugin-id>',
            insertText: '/plugin check ',
          },
          options: [
            {
              kind: 'string',
              name: 'plugin-id',
              description: 'Plugin id to inspect',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'reload',
          description: 'Reload all plugins without restarting the gateway',
        },
        {
          kind: 'subcommand',
          name: 'uninstall',
          description:
            'Remove a home-installed plugin and matching runtime config overrides',
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Plugin id to uninstall',
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'bot',
      description: 'List, inspect, or set the chatbot for this session',
      options: [
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List available bots',
        },
        {
          kind: 'subcommand',
          name: 'set',
          description: 'Set chatbot for this session',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Bot id or bot name',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'clear',
          description: 'Clear the chatbot for this session',
        },
        {
          kind: 'subcommand',
          name: 'info',
          description: 'Show current chatbot settings',
        },
      ],
    },
    {
      name: 'rag',
      description:
        'Toggle or set retrieval-augmented generation for this session',
      tuiMenuEntries: [
        {
          id: 'rag.on',
          label: '/rag on',
          insertText: '/rag on',
          description: 'Enable retrieval-augmented generation for this session',
        },
        {
          id: 'rag.off',
          label: '/rag off',
          insertText: '/rag off',
          description:
            'Disable retrieval-augmented generation for this session',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'mode',
          description: 'Set RAG on or off, or omit to toggle',
          choices: RAG_MODE_CHOICES,
        },
      ],
    },
    {
      name: 'ralph',
      description: 'Inspect or configure Ralph loop iterations',
      options: [
        {
          kind: 'subcommand',
          name: 'info',
          description: 'Show current Ralph loop settings',
        },
        {
          kind: 'subcommand',
          name: 'on',
          description: 'Enable Ralph loop',
        },
        {
          kind: 'subcommand',
          name: 'off',
          description: 'Disable Ralph loop',
        },
        {
          kind: 'subcommand',
          name: 'set',
          description: 'Set Ralph loop iterations',
          options: [
            {
              kind: 'string',
              name: 'iterations',
              description: '0 disables, -1 is unlimited, 1-64 are extra turns',
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'mcp',
      description: 'Manage configured MCP servers',
      options: [
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List configured MCP servers',
        },
        {
          kind: 'subcommand',
          name: 'add',
          description: 'Add or update an MCP server config',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
            {
              kind: 'string',
              name: 'config',
              description: 'JSON configuration payload',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'remove',
          description: 'Remove an MCP server config',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'toggle',
          description: 'Enable or disable an MCP server',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'reconnect',
          description: 'Reconnect an MCP server on the next turn',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'clear',
      description: 'Clear session history',
    },
    {
      name: 'reset',
      description:
        'Clear session history, reset session settings, and remove the current agent workspace',
      tuiMenuEntries: [
        {
          id: 'reset.yes',
          label: '/reset yes',
          insertText: '/reset yes',
          description: 'Confirm a full session reset and remove the workspace',
        },
        {
          id: 'reset.no',
          label: '/reset no',
          insertText: '/reset no',
          description: 'Cancel a pending reset command',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'confirm',
          description: 'Confirm or cancel the reset',
          choices: RESET_CONFIRM_CHOICES,
        },
      ],
    },
    {
      name: 'usage',
      description: 'Show usage and cost aggregates',
      tuiMenuEntries: [
        {
          id: 'usage.summary',
          label: '/usage summary',
          insertText: '/usage summary',
          description: 'Show the current usage summary',
        },
        {
          id: 'usage.daily',
          label: '/usage daily',
          insertText: '/usage daily',
          description: 'Show daily usage totals',
        },
        {
          id: 'usage.monthly',
          label: '/usage monthly',
          insertText: '/usage monthly',
          description: 'Show monthly usage totals',
        },
        {
          id: 'usage.model',
          label: '/usage model [daily|monthly] [agent_id]',
          insertText: '/usage model ',
          description:
            'Show per-model usage, optionally scoped to a window and agent id',
        },
        {
          id: 'usage.model.daily',
          label: '/usage model daily [agent_id]',
          insertText: '/usage model daily ',
          description:
            'Show per-model daily usage, optionally filtered by agent',
          depth: 3,
        },
        {
          id: 'usage.model.monthly',
          label: '/usage model monthly [agent_id]',
          insertText: '/usage model monthly ',
          description:
            'Show per-model monthly usage, optionally filtered by agent',
          depth: 3,
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'view',
          description: 'Summary view to render',
          choices: USAGE_VIEW_CHOICES,
        },
        {
          kind: 'string',
          name: 'window',
          description: 'Optional window for model view',
          choices: USAGE_WINDOW_CHOICES,
        },
        {
          kind: 'string',
          name: 'agent_id',
          description: 'Optional agent id filter for model view',
        },
      ],
    },
    {
      name: 'export',
      description: 'Export a session JSONL snapshot',
      tuiMenuEntries: [
        {
          id: 'export.session',
          label: '/export session [session_id]',
          insertText: '/export session ',
          description:
            'Export the current or specified session as a JSONL snapshot',
        },
        {
          id: 'export.trace',
          label: '/export trace [session_id|all]',
          insertText: '/export trace ',
          description:
            'Export the current or specified session as an ATIF-compatible trace JSONL',
        },
        {
          id: 'export.trace.all',
          label: '/export trace all',
          insertText: '/export trace all',
          description: 'Export all sessions as ATIF-compatible trace JSONL',
          depth: 3,
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'session_id',
          description: 'Optional session id (defaults to current session)',
        },
      ],
    },
    {
      name: 'sessions',
      description: 'List chat sessions or inspect active sandbox sessions',
    },
    {
      name: 'audit',
      description: 'Show audit details for a session',
      options: [
        {
          kind: 'string',
          name: 'session_id',
          description: 'Optional session id (defaults to current session)',
        },
      ],
    },
    {
      name: 'schedule',
      description: 'Manage scheduled tasks for this session',
      options: [
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List scheduled tasks',
        },
        {
          kind: 'subcommand',
          name: 'add',
          description: 'Add a cron, at, or every schedule',
          options: [
            {
              kind: 'string',
              name: 'spec',
              description:
                'Examples: "*/5 * * * *" check logs, at "2026-03-10T12:00:00Z" run report',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'remove',
          description: 'Remove a scheduled task',
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Task id',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'toggle',
          description: 'Enable or disable a scheduled task',
          options: [
            {
              kind: 'string',
              name: 'id',
              description: 'Task id',
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'eval',
      description:
        'Local eval recipes and detached benchmark runs via the OpenAI-compatible gateway',
      tuiOnly: true,
      tuiMenu: {
        label: '/eval [list|env|<suite>|<command...>]',
        insertText: '/eval ',
      },
      tuiMenuEntries: [
        {
          id: 'eval.list',
          label: '/eval list',
          insertText: '/eval list',
          description: 'List supported eval suites and starter recipes',
        },
        {
          id: 'eval.env',
          label: '/eval env',
          insertText: '/eval env',
          description:
            'Show the injected OpenAI-compatible base URL and model without exposing tokens',
        },
        {
          id: 'eval.swebench-verified',
          label: '/eval swebench-verified',
          insertText: '/eval swebench-verified',
          description: 'Stub entry for a planned SWE-bench Verified runner',
        },
        {
          id: 'eval.locomo',
          label: '/eval locomo',
          insertText: '/eval locomo',
          description: 'Show the native LOCOMO memory benchmark commands',
        },
        {
          id: 'eval.locomo.setup',
          label: '/eval locomo setup',
          insertText: '/eval locomo setup',
          description:
            'Download the official LOCOMO dataset into the local eval workspace',
        },
        {
          id: 'eval.locomo.run',
          label: '/eval locomo run --budget 4000 --num-samples 2',
          insertText: '/eval locomo run --budget 4000 --num-samples 2',
          description:
            'Run a small native LOCOMO memory benchmark sample with recent-tail and semantic-recall modes',
        },
        {
          id: 'eval.locomo.results',
          label: '/eval locomo results',
          insertText: '/eval locomo results',
          description: 'Show the latest LOCOMO summary and comparison metrics',
        },
        {
          id: 'eval.terminal-bench-2.0',
          label: '/eval terminal-bench-2.0',
          insertText: '/eval terminal-bench-2.0',
          description: 'Show the Terminal-Bench 2.0 starter recipe',
        },
        {
          id: 'eval.terminal-bench-2.0.setup',
          label: '/eval terminal-bench-2.0 setup',
          insertText: '/eval terminal-bench-2.0 setup',
          description:
            'Install the native Terminal-Bench dataset helper into the local eval workspace',
        },
        {
          id: 'eval.terminal-bench-2.0.run',
          label: '/eval terminal-bench-2.0 run --num-tasks 10',
          insertText: '/eval terminal-bench-2.0 run --num-tasks 10',
          description:
            'Run 10 Terminal-Bench tasks through the native HybridClaw harness',
        },
        {
          id: 'eval.terminal-bench-2.0.results',
          label: '/eval terminal-bench-2.0 results',
          insertText: '/eval terminal-bench-2.0 results',
          description: 'Show the latest Terminal-Bench summary and score',
        },
        {
          id: 'eval.terminal-bench-2.0.logs',
          label: '/eval terminal-bench-2.0 logs',
          insertText: '/eval terminal-bench-2.0 logs',
          description:
            'Show tailed stdout/stderr for the latest Terminal-Bench job',
        },
        {
          id: 'eval.tau2',
          label: '/eval tau2',
          insertText: '/eval tau2',
          description: 'Show managed tau2 eval commands',
        },
        {
          id: 'eval.tau2.setup',
          label: '/eval tau2 setup',
          insertText: '/eval tau2 setup',
          description: 'Clone and install tau2 into the local eval workspace',
        },
        {
          id: 'eval.tau2.run',
          label:
            '/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10',
          insertText:
            '/eval tau2 run --domain telecom --num-trials 1 --num-tasks 10',
          description:
            'Run a 10-task telecom tau2 sample with default eval models',
        },
        {
          id: 'eval.tau2.status',
          label: '/eval tau2 status',
          insertText: '/eval tau2 status',
          description: 'Show tau2 install state and latest managed run',
        },
        {
          id: 'eval.tau2.results',
          label: '/eval tau2 results',
          insertText: '/eval tau2 results',
          description: 'Show the latest tau2 run log tail and result paths',
        },
        {
          id: 'eval.agentbench',
          label: '/eval agentbench',
          insertText: '/eval agentbench',
          description: 'Stub entry for a planned AgentBench runner',
        },
        {
          id: 'eval.gaia',
          label: '/eval gaia',
          insertText: '/eval gaia',
          description: 'Stub entry for a planned GAIA runner',
        },
      ],
      options: [
        {
          kind: 'string',
          name: 'target',
          description: 'list, env, run, or a supported eval suite',
        },
        {
          kind: 'string',
          name: 'args',
          description: 'Optional shell command tail for `run`',
        },
      ],
    },
    {
      name: 'fullauto',
      description: 'Enable, inspect, disable, or steer session full-auto mode',
      tuiMenu: {
        label: '/fullauto [status|off|on [prompt]|<prompt>]',
        insertText: '/fullauto ',
      },
      tuiOnly: true,
      options: [
        {
          kind: 'subcommand',
          name: 'status',
          description: 'Show the current full-auto runtime status',
        },
        {
          kind: 'subcommand',
          name: 'on',
          description:
            'Enable full-auto, optionally with a custom objective prompt',
          options: [
            {
              kind: 'string',
              name: 'prompt',
              description: 'Optional full-auto objective prompt',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'off',
          description: 'Disable full-auto for the current session',
        },
      ],
    },
    {
      name: 'skill',
      description:
        'Inspect skill dependencies and health, review recent runs, manage amendments, and import or sync community skills',
      tuiOnly: true,
      options: [
        {
          kind: 'subcommand',
          name: 'config',
          description: 'Open the interactive skill enable/disable checklist',
        },
        {
          kind: 'subcommand',
          name: 'list',
          description: 'List available skills and their current availability',
        },
        {
          kind: 'subcommand',
          name: 'enable',
          description:
            'Enable a skill globally or for a specific channel kind',
          tuiMenu: {
            label: '/skill enable <name> [--channel <kind>]',
            insertText: '/skill enable ',
            aliases: ['/skill enable <name> [--channel <kind>]'],
          },
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Skill name to enable',
              required: true,
            },
            {
              kind: 'string',
              name: 'channel',
              description:
                'Optional channel kind to scope the change (e.g. discord, slack)',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'disable',
          description:
            'Disable a skill globally or for a specific channel kind',
          tuiMenu: {
            label: '/skill disable <name> [--channel <kind>]',
            insertText: '/skill disable ',
            aliases: ['/skill disable <name> [--channel <kind>]'],
          },
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Skill name to disable',
              required: true,
            },
            {
              kind: 'string',
              name: 'channel',
              description:
                'Optional channel kind to scope the change (e.g. discord, slack)',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'inspect',
          description: 'Inspect one skill or all observed skills',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Skill name',
              required: true,
            },
          ],
          tuiMenuEntries: [
            {
              id: 'skill.inspect.all',
              label: '/skill inspect --all',
              insertText: '/skill inspect --all',
              description:
                'Inspect all skills with observations in the current window',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'runs',
          description: 'Show recent execution observations for a skill',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Skill name',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'install',
          description: 'Install one declared dependency for a skill',
          tuiMenu: {
            label: '/skill install <skill> <dependency>',
            insertText: '/skill install ',
            aliases: ['/skill install <skill> <dependency>'],
          },
          options: [
            {
              kind: 'string',
              name: 'skill',
              description: 'Skill name',
              required: true,
            },
            {
              kind: 'string',
              name: 'dependency',
              description: 'Dependency id declared by that skill',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'learn',
          description: 'Stage, apply, reject, or roll back a skill amendment',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Skill name',
              required: true,
            },
          ],
          tuiMenuEntries: [
            {
              id: 'skill.learn.apply',
              label: '/skill learn <name> --apply',
              insertText: '/skill learn ',
              description: 'Apply the latest staged amendment for a skill',
            },
            {
              id: 'skill.learn.reject',
              label: '/skill learn <name> --reject',
              insertText: '/skill learn ',
              description: 'Reject the latest staged amendment for a skill',
            },
            {
              id: 'skill.learn.rollback',
              label: '/skill learn <name> --rollback',
              insertText: '/skill learn ',
              description: 'Roll back the latest applied amendment for a skill',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'history',
          description: 'Show amendment history for a skill',
          options: [
            {
              kind: 'string',
              name: 'name',
              description: 'Skill name',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'sync',
          description: 'Reinstall a packaged or community skill',
          tuiMenu: {
            label: '/skill sync <source>',
            insertText: '/skill sync ',
            aliases: ['/skill sync <source> [--skip-skill-scan]'],
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description: 'Skill source identifier or URL',
              required: true,
            },
            {
              kind: 'string',
              name: 'skip-skill-scan',
              description:
                'Optional --skip-skill-scan override to bypass the scanner',
              choices: [
                { name: '--skip-skill-scan', value: '--skip-skill-scan' },
              ],
            },
          ],
          tuiMenuEntries: [
            {
              id: 'skill.sync',
              label: '/skill sync <source> --skip-skill-scan',
              insertText: '/skill sync --skip-skill-scan ',
              description:
                'Reinstall a packaged or community skill from its source and bypass the scanner',
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'import',
          description: 'Import a packaged or community skill',
          tuiMenu: {
            label: '/skill import <source>',
            insertText: '/skill import ',
            aliases: ['/skill import <source> [--force] [--skip-skill-scan]'],
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description: 'Skill source identifier or URL',
              required: true,
            },
            {
              kind: 'string',
              name: 'force',
              description: 'Optional --force override for caution findings',
              choices: [{ name: '--force', value: '--force' }],
            },
            {
              kind: 'string',
              name: 'skip-skill-scan',
              description:
                'Optional --skip-skill-scan override to bypass the scanner',
              choices: [
                { name: '--skip-skill-scan', value: '--skip-skill-scan' },
              ],
            },
          ],
          tuiMenuEntries: [
            {
              id: 'skill.import.force',
              label: '/skill import --force <source>',
              insertText: '/skill import --force ',
              description:
                'Import a reviewed community skill and override caution findings',
            },
          ],
        },
      ],
    },
    {
      name: 'info',
      description: 'Show current bot, model, and runtime settings together',
      tuiOnly: true,
    },
    {
      name: 'paste',
      description: 'Attach a copied file or clipboard image',
      tuiOnly: true,
      localSurfaces: ['tui'],
    },
    {
      name: 'stop',
      description: 'Interrupt the current request and disable full-auto',
      tuiMenu: {
        aliases: ['abort'],
      },
      tuiOnly: true,
    },
    {
      name: 'exit',
      description: 'Quit the TUI',
      tuiMenu: {
        aliases: ['quit', 'q'],
      },
      tuiOnly: true,
      localSurfaces: ['tui'],
    },
  ];
}

export function buildCanonicalSlashCommandDefinitions(
  modelChoices: Array<{ name: string; value: string }>,
): CanonicalSlashCommandDefinition[] {
  return buildSlashCommandCatalogDefinitions(modelChoices).filter(
    (definition) => !definition.tuiOnly,
  );
}

export function buildTuiSlashCommandDefinitions(
  modelChoices: Array<{ name: string; value: string }>,
  pluginCommands: PluginSlashCommandCatalogEntry[] = [],
): CanonicalSlashCommandDefinition[] {
  const definitions = buildSlashCommandCatalogDefinitions(modelChoices);
  const known = new Set(definitions.map((definition) => definition.name));
  for (const pluginCommand of pluginCommands) {
    const name = pluginCommand.name.trim().toLowerCase();
    if (!name || known.has(name)) continue;
    definitions.push({
      name,
      description:
        pluginCommand.description?.trim() || 'Run a plugin-provided command',
    });
    known.add(name);
  }
  return definitions;
}

export function buildLocalSessionSlashHelpEntries(
  surface: LocalSessionSurface,
): LocalSessionSlashHelpEntry[] {
  return buildTuiSlashCommandDefinitions([])
    .flatMap((definition) => {
      if (!isAvailableOnLocalSurface(definition, surface)) {
        return [];
      }
      const presentation = LOCAL_SESSION_HELP_PRESENTATIONS[definition.name];
      if (presentation?.surfaces && !presentation.surfaces.includes(surface)) {
        return [];
      }
      return [
        {
          command:
            presentation?.commandBySurface?.[surface] ??
            presentation?.command ??
            `/${definition.name}`,
          description: presentation?.description ?? definition.description,
        },
      ];
    })
    .sort((left, right) => {
      const commandCompare = compareCommandLabels(left.command, right.command);
      if (commandCompare !== 0) return commandCompare;
      return compareCommandLabels(left.description, right.description);
    });
}

export function parseCanonicalSlashCommandArgs(
  interaction: CanonicalSlashInteractionInput,
): string[] | null {
  switch (interaction.commandName) {
    case 'status':
      return ['status'];

    case 'auth': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand !== 'status') return null;
      const provider = normalizeStringOption(interaction, 'provider', true);
      return provider ? ['auth', 'status', provider] : null;
    }

    case 'config': {
      const action = normalizeStringOption(interaction, 'action');
      const key = normalizeStringOption(interaction, 'key');
      const value = normalizeStringOption(interaction, 'value');
      if (!action && !key && !value) return ['config'];
      if (action === 'check' && !key && !value) return ['config', 'check'];
      if (action === 'reload' && !key && !value) return ['config', 'reload'];
      if (action !== 'set' || !key || !value) return null;
      return ['config', 'set', key, value];
    }

    case 'policy': {
      const subcommand = normalizeSubcommand(interaction);
      if (!subcommand || subcommand === 'status') return ['policy'];
      if (subcommand === 'list') {
        const agent = normalizeStringOption(interaction, 'agent');
        const json = normalizeStringOption(interaction, 'json');
        return [
          'policy',
          'list',
          ...(agent ? ['--agent', agent] : []),
          ...(json === '--json' ? ['--json'] : []),
        ];
      }
      if (subcommand === 'allow' || subcommand === 'deny') {
        const host = normalizeStringOption(interaction, 'host', true);
        if (!host) return null;
        const agent = normalizeStringOption(interaction, 'agent');
        const methods = normalizeStringOption(interaction, 'methods');
        const paths = normalizeStringOption(interaction, 'paths');
        const port = normalizeStringOption(interaction, 'port');
        const comment = normalizeStringOption(interaction, 'comment');
        return [
          'policy',
          subcommand,
          host,
          ...(agent ? ['--agent', agent] : []),
          ...(methods ? ['--methods', methods] : []),
          ...(paths ? ['--paths', paths] : []),
          ...(port ? ['--port', port] : []),
          ...(comment ? ['--comment', comment] : []),
        ];
      }
      if (subcommand === 'delete') {
        const target = normalizeStringOption(interaction, 'target', true);
        return target ? ['policy', 'delete', target] : null;
      }
      if (subcommand === 'reset') return ['policy', 'reset'];
      if (subcommand === 'default') {
        const mode = normalizeStringOption(interaction, 'mode', true);
        return mode === 'allow' || mode === 'deny'
          ? ['policy', 'default', mode]
          : null;
      }
      if (subcommand === 'preset') {
        const action = normalizeStringOption(interaction, 'action');
        const name = normalizeStringOption(interaction, 'name');
        const dryRun = normalizeStringOption(interaction, 'dry-run');
        if (!action || action === 'list') return ['policy', 'preset', 'list'];
        if (action === 'add') {
          return name
            ? [
                'policy',
                'preset',
                'add',
                name,
                ...(dryRun === '--dry-run' ? ['--dry-run'] : []),
              ]
            : null;
        }
        if (action === 'remove') {
          return name ? ['policy', 'preset', 'remove', name] : null;
        }
        return null;
      }
      return null;
    }

    case 'secret': {
      const action = normalizeStringOption(interaction, 'action');
      const name = normalizeStringOption(interaction, 'name');
      const value = normalizeStringOption(interaction, 'value');
      if (!action && !name && !value) return ['secret'];
      if (action === 'list' && !name && !value) return ['secret', 'list'];
      if ((action === 'unset' || action === 'show') && name && !value) {
        return ['secret', action, name];
      }
      if (action === 'set' && name && value) {
        return ['secret', 'set', name, value];
      }
      if (action === 'route' && name) {
        const routeArgs = value ? tokenizeFreeformText(value) : [];
        return ['secret', 'route', name, ...routeArgs];
      }
      return null;
    }

    case 'voice': {
      const subcommand = normalizeSubcommand(interaction);
      if (!subcommand || subcommand === 'info') return ['voice', 'info'];
      if (subcommand === 'call') {
        const number = normalizeStringOption(interaction, 'number', true);
        return number ? ['voice', 'call', number] : null;
      }
      return null;
    }

    case 'show': {
      const subcommand = normalizeSubcommand(interaction);
      if (
        subcommand === 'all' ||
        subcommand === 'thinking' ||
        subcommand === 'tools' ||
        subcommand === 'none'
      ) {
        return ['show', subcommand];
      }
      return null;
    }

    case 'approve': {
      const action =
        normalizeStringOption(interaction, 'action')?.toLowerCase() || 'view';
      if (
        action !== 'view' &&
        action !== 'yes' &&
        action !== 'session' &&
        action !== 'agent' &&
        action !== 'no'
      ) {
        return null;
      }
      const approvalId = normalizeStringOption(interaction, 'approval_id');
      return approvalId ? ['approve', action, approvalId] : ['approve', action];
    }

    case 'compact':
      return ['compact'];

    case 'dream': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand === 'now' || subcommand === 'on' || subcommand === 'off') {
        return ['dream', subcommand];
      }
      return subcommand ? null : ['dream'];
    }

    case 'channel-mode': {
      const mode = normalizeStringOption(interaction, 'mode', true);
      if (mode !== 'off' && mode !== 'mention' && mode !== 'free') {
        return null;
      }
      return ['channel', 'mode', mode];
    }

    case 'channel-policy': {
      const policy = normalizeStringOption(interaction, 'policy', true);
      if (
        policy !== 'open' &&
        policy !== 'allowlist' &&
        policy !== 'disabled'
      ) {
        return null;
      }
      return ['channel', 'policy', policy];
    }

    case 'model': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand === 'info') return ['model', 'info'];
      if (subcommand === 'list') {
        const provider = normalizeStringOption(interaction, 'provider');
        return provider ? ['model', 'list', provider] : ['model', 'list'];
      }
      if (subcommand === 'set') {
        const selectedModel = normalizeStringOption(interaction, 'name', true);
        return selectedModel ? ['model', 'set', selectedModel] : null;
      }
      if (subcommand === 'clear') return ['model', 'clear'];
      if (subcommand === 'default') {
        const selectedModel = normalizeStringOption(interaction, 'name');
        return selectedModel
          ? ['model', 'default', selectedModel]
          : ['model', 'default'];
      }
      return null;
    }

    case 'concierge': {
      const subcommand = normalizeSubcommand(interaction);
      if (!subcommand || subcommand === 'info') return ['concierge', 'info'];
      if (
        subcommand === 'on' ||
        subcommand === 'off' ||
        subcommand === 'enable' ||
        subcommand === 'disable'
      ) {
        return ['concierge', subcommand];
      }
      if (subcommand === 'model') {
        const selectedModel = normalizeStringOption(interaction, 'name');
        return selectedModel
          ? ['concierge', 'model', selectedModel]
          : ['concierge', 'model'];
      }
      if (subcommand === 'profile') {
        const profile = normalizeStringOption(interaction, 'profile', true);
        if (!profile) return null;
        const selectedModel = normalizeStringOption(interaction, 'model');
        return selectedModel
          ? ['concierge', 'profile', profile, selectedModel]
          : ['concierge', 'profile', profile];
      }
      return null;
    }

    case 'agent': {
      const subcommand = normalizeSubcommand(interaction);
      if (!subcommand || subcommand === 'info') return ['agent'];
      if (subcommand === 'list') return ['agent', 'list'];
      if (subcommand === 'switch') {
        const agentId = normalizeStringOption(interaction, 'id', true);
        return agentId ? ['agent', 'switch', agentId] : null;
      }
      if (subcommand === 'model') {
        const model = normalizeStringOption(interaction, 'name');
        return model ? ['agent', 'model', model] : ['agent', 'model'];
      }
      if (subcommand === 'create') {
        const agentId = normalizeStringOption(interaction, 'id', true);
        if (!agentId) return null;
        const model = normalizeStringOption(interaction, 'model');
        return model
          ? ['agent', 'create', agentId, '--model', model]
          : ['agent', 'create', agentId];
      }
      if (subcommand === 'install') {
        const source = normalizeStringOption(interaction, 'source', true);
        if (!source) return null;
        const agentId = normalizeStringOption(interaction, 'id');
        const force = normalizeStringOption(interaction, 'force');
        const skipSkillScan = normalizeStringOption(
          interaction,
          'skip-skill-scan',
        );
        const skipExternals = normalizeStringOption(
          interaction,
          'skip-externals',
        );
        const skipImportErrors = normalizeStringOption(
          interaction,
          'skip-import-errors',
        );
        const yes = normalizeStringOption(interaction, 'yes');
        if (
          (force && force !== '--force') ||
          (skipSkillScan && skipSkillScan !== '--skip-skill-scan') ||
          (skipExternals && skipExternals !== '--skip-externals') ||
          (skipImportErrors && skipImportErrors !== '--skip-import-errors') ||
          (yes && yes !== '--yes')
        ) {
          return null;
        }
        return [
          'agent',
          'install',
          source,
          ...(agentId ? ['--id', agentId] : []),
          ...(force ? ['--force'] : []),
          ...(skipSkillScan ? ['--skip-skill-scan'] : []),
          ...(skipExternals ? ['--skip-externals'] : []),
          ...(skipImportErrors ? ['--skip-import-errors'] : []),
          ...(yes ? ['--yes'] : []),
        ];
      }
      return null;
    }

    case 'help':
      return ['help'];

    case 'bot': {
      const subcommand = normalizeSubcommand(interaction);
      if (
        subcommand === 'list' ||
        subcommand === 'info' ||
        subcommand === 'clear'
      ) {
        return ['bot', subcommand];
      }
      if (subcommand === 'set') {
        const name = normalizeStringOption(interaction, 'name', true);
        return name ? ['bot', 'set', name] : null;
      }
      return null;
    }

    case 'rag': {
      const mode = normalizeStringOption(interaction, 'mode');
      if (!mode) return ['rag'];
      if (mode !== 'on' && mode !== 'off') return null;
      return ['rag', mode];
    }

    case 'ralph': {
      const subcommand = normalizeSubcommand(interaction);
      if (
        subcommand === 'info' ||
        subcommand === 'on' ||
        subcommand === 'off'
      ) {
        return ['ralph', subcommand];
      }
      if (subcommand === 'set') {
        const iterations = normalizeStringOption(
          interaction,
          'iterations',
          true,
        );
        return iterations ? ['ralph', 'set', iterations] : null;
      }
      return null;
    }

    case 'mcp': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand === 'list') return ['mcp', 'list'];
      if (
        subcommand === 'remove' ||
        subcommand === 'toggle' ||
        subcommand === 'reconnect'
      ) {
        const name = normalizeStringOption(interaction, 'name', true);
        return name ? ['mcp', subcommand, name] : null;
      }
      if (subcommand === 'add') {
        const name = normalizeStringOption(interaction, 'name', true);
        const config = normalizeStringOption(interaction, 'config', true);
        return name && config ? ['mcp', 'add', name, config] : null;
      }
      return null;
    }

    case 'plugin': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand === 'list') return ['plugin', 'list'];
      if (subcommand === 'enable' || subcommand === 'disable') {
        const pluginId = normalizeStringOption(interaction, 'id', true);
        return pluginId ? ['plugin', subcommand, pluginId] : null;
      }
      if (subcommand === 'config') {
        const pluginId = normalizeStringOption(interaction, 'id', true);
        const key = normalizeStringOption(interaction, 'key');
        const value = normalizeStringOption(interaction, 'value');
        if (!pluginId) return null;
        if (!key) return ['plugin', 'config', pluginId];
        if (!value) return ['plugin', 'config', pluginId, key];
        return ['plugin', 'config', pluginId, key, value];
      }
      if (subcommand === 'install') {
        const source = normalizeStringOption(interaction, 'source', true);
        const yes = normalizeStringOption(interaction, 'yes');
        if (!source || (yes && yes !== '--yes')) return null;
        return ['plugin', 'install', source, ...(yes ? ['--yes'] : [])];
      }
      if (subcommand === 'reinstall') {
        const source = normalizeStringOption(interaction, 'source', true);
        const yes = normalizeStringOption(interaction, 'yes');
        if (!source || (yes && yes !== '--yes')) return null;
        return ['plugin', 'reinstall', source, ...(yes ? ['--yes'] : [])];
      }
      if (subcommand === 'check') {
        const pluginId = normalizeStringOption(interaction, 'plugin-id', true);
        return pluginId ? ['plugin', 'check', pluginId] : null;
      }
      if (subcommand === 'reload') return ['plugin', 'reload'];
      if (subcommand === 'uninstall') {
        const pluginId = normalizeStringOption(interaction, 'id', true);
        return pluginId ? ['plugin', 'uninstall', pluginId] : null;
      }
      return null;
    }

    case 'clear':
      return ['clear'];

    case 'reset': {
      const confirm = normalizeStringOption(interaction, 'confirm');
      if (!confirm) return ['reset'];
      if (confirm !== 'yes' && confirm !== 'no') return null;
      return ['reset', confirm];
    }

    case 'usage': {
      const view = normalizeStringOption(interaction, 'view')?.toLowerCase();
      const window = normalizeStringOption(
        interaction,
        'window',
      )?.toLowerCase();
      const agentId = normalizeStringOption(interaction, 'agent_id');
      if (!view) return ['usage'];
      if (
        view !== 'summary' &&
        view !== 'daily' &&
        view !== 'monthly' &&
        view !== 'model'
      ) {
        return null;
      }
      if (view !== 'model') {
        return ['usage', view];
      }
      if (window && window !== 'daily' && window !== 'monthly') {
        return null;
      }
      return [
        'usage',
        'model',
        ...(window ? [window] : []),
        ...(agentId ? [agentId] : []),
      ];
    }

    case 'export': {
      const sessionId = normalizeStringOption(interaction, 'session_id');
      return sessionId
        ? ['export', 'session', sessionId]
        : ['export', 'session'];
    }

    case 'sessions':
      return ['sessions'];

    case 'audit': {
      const sessionId = normalizeStringOption(interaction, 'session_id');
      return sessionId ? ['audit', sessionId] : ['audit'];
    }

    case 'schedule': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand === 'list') return ['schedule', 'list'];
      if (subcommand === 'remove' || subcommand === 'toggle') {
        const id = normalizeStringOption(interaction, 'id', true);
        return id ? ['schedule', subcommand, id] : null;
      }
      if (subcommand === 'add') {
        const spec = normalizeStringOption(interaction, 'spec', true);
        if (!spec) return null;
        const parts = tokenizeFreeformText(spec);
        return parts.length > 0 ? ['schedule', 'add', ...parts] : null;
      }
      return null;
    }

    default:
      return null;
  }
}
