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

export interface CanonicalSlashCommandDefinition {
  name: string;
  description: string;
  options?: CanonicalSlashCommandOptionDefinition[];
  tuiMenu?: CanonicalTuiMenuPresentation;
  tuiMenuEntries?: CanonicalTuiMenuEntryDefinition[];
  tuiOnly?: boolean;
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

const REGISTERED_TEXT_COMMAND_NAMES = new Set([
  'agent',
  'auth',
  'bot',
  'config',
  'rag',
  'model',
  'status',
  'show',
  'approve',
  'usage',
  'export',
  'sessions',
  'audit',
  'schedule',
  'channel',
  'ralph',
  'mcp',
  'plugin',
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
  { name: 'vllm', value: 'vllm' },
] satisfies Array<{ name: string; value: string }>;

function tokenizeFreeformText(value: string): string[] {
  return value.match(/"[^"]*"|\S+/g) ?? [];
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
        const source = parts.slice(2).join(' ').trim();
        return source ? ['plugin', 'install', source] : ['plugin', 'install'];
      }
      if (sub === 'reinstall') {
        const source = parts.slice(2).join(' ').trim();
        return source
          ? ['plugin', 'reinstall', source]
          : ['plugin', 'reinstall'];
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

    case 'fullauto':
      return parts.length > 1 ? ['fullauto', ...parts.slice(1)] : ['fullauto'];

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
            label: '/plugin install <path|npm-spec>',
            insertText: '/plugin install ',
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description: 'Local plugin path or npm package spec',
              required: true,
            },
          ],
        },
        {
          kind: 'subcommand',
          name: 'reinstall',
          description:
            'Replace an installed plugin from a local TUI/web session',
          tuiMenu: {
            label: '/plugin reinstall <path|npm-spec>',
            insertText: '/plugin reinstall ',
          },
          options: [
            {
              kind: 'string',
              name: 'source',
              description: 'Local plugin path or npm package spec',
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
      description: 'List active sessions',
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
        'Inspect skill health, review recent runs, manage amendments, and import or sync community skills',
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
        return source ? ['plugin', 'install', source] : null;
      }
      if (subcommand === 'reinstall') {
        const source = normalizeStringOption(interaction, 'source', true);
        return source ? ['plugin', 'reinstall', source] : null;
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
