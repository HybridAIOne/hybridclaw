import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
} from 'discord.js';

export interface SlashCommandDefinition {
  name: string;
  description: string;
  dmPermission?: boolean;
  options?: SlashCommandOptionDefinition[];
}

type SlashCommandStringOptionDefinition = {
  type: ApplicationCommandOptionType.String;
  name: string;
  description: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string }>;
};

type SlashCommandSubcommandOptionDefinition = {
  type: ApplicationCommandOptionType.Subcommand;
  name: string;
  description: string;
  options?: SlashCommandStringOptionDefinition[];
};

export type SlashCommandOptionDefinition =
  | SlashCommandStringOptionDefinition
  | SlashCommandSubcommandOptionDefinition;

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

const USAGE_VIEW_CHOICES = [
  { name: 'summary', value: 'summary' },
  { name: 'daily', value: 'daily' },
  { name: 'monthly', value: 'monthly' },
  { name: 'model', value: 'model' },
] satisfies Array<{ name: string; value: string }>;

const GLOBAL_SLASH_COMMANDS = new Set(['status', 'approve']);

function tokenizeFreeformText(value: string): string[] {
  return value.match(/"[^"]*"|\S+/g) ?? [];
}

function normalizeStringOption(
  interaction: ChatInputCommandInteraction,
  name: string,
  required = false,
): string | null {
  const value = interaction.options.getString(name, required)?.trim() ?? '';
  return value || null;
}

function normalizeSubcommand(
  interaction: ChatInputCommandInteraction,
): string | null {
  const value = interaction.options.getSubcommand(false)?.trim().toLowerCase();
  return value || null;
}

export function isGlobalSlashCommand(name: string): boolean {
  return GLOBAL_SLASH_COMMANDS.has(name);
}

export function buildSlashCommandDefinitions(
  modelChoices: Array<{ name: string; value: string }>,
): SlashCommandDefinition[] {
  return [
    {
      name: 'status',
      description: 'Show HybridClaw runtime status (only visible to you)',
      dmPermission: true,
    },
    {
      name: 'approve',
      description: 'View/respond to pending tool approval requests (private)',
      dmPermission: true,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'action',
          description: 'Action to perform',
          choices: APPROVAL_ACTION_CHOICES,
        },
        {
          type: ApplicationCommandOptionType.String,
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
      options: [
        {
          type: ApplicationCommandOptionType.String,
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
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'policy',
          description: 'Guild channel policy',
          required: true,
          choices: CHANNEL_POLICY_CHOICES,
        },
      ],
    },
    {
      name: 'model',
      description: 'Inspect or set the default runtime model',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'info',
          description: 'Show current default model and available models',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'default',
          description: 'Set default model for new sessions',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'name',
              description: 'Model name',
              required: true,
              choices: modelChoices.length > 0 ? modelChoices : undefined,
            },
          ],
        },
      ],
    },
    {
      name: 'help',
      description: 'Show available HybridClaw commands',
    },
    {
      name: 'bot',
      description: 'List, inspect, or set the chatbot for this session',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: 'List available bots',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'set',
          description: 'Set chatbot for this session',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'name',
              description: 'Bot id or bot name',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'info',
          description: 'Show current chatbot settings',
        },
      ],
    },
    {
      name: 'rag',
      description:
        'Toggle or set retrieval-augmented generation for this session',
      options: [
        {
          type: ApplicationCommandOptionType.String,
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
          type: ApplicationCommandOptionType.Subcommand,
          name: 'info',
          description: 'Show current Ralph loop settings',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'on',
          description: 'Enable Ralph loop',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'off',
          description: 'Disable Ralph loop',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'set',
          description: 'Set Ralph loop iterations',
          options: [
            {
              type: ApplicationCommandOptionType.String,
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
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: 'List configured MCP servers',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'add',
          description: 'Add or update an MCP server config',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'config',
              description: 'JSON configuration payload',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'remove',
          description: 'Remove an MCP server config',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'toggle',
          description: 'Enable or disable an MCP server',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'name',
              description: 'MCP server name',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'reconnect',
          description: 'Reconnect an MCP server on the next turn',
          options: [
            {
              type: ApplicationCommandOptionType.String,
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
      name: 'usage',
      description: 'Show usage and cost aggregates',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'view',
          description: 'Summary view to render',
          choices: USAGE_VIEW_CHOICES,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'agent_id',
          description: 'Optional agent id filter for model view',
        },
      ],
    },
    {
      name: 'export',
      description: 'Export a session JSONL snapshot',
      options: [
        {
          type: ApplicationCommandOptionType.String,
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
          type: ApplicationCommandOptionType.String,
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
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: 'List scheduled tasks',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'add',
          description: 'Add a cron, at, or every schedule',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'spec',
              description:
                'Examples: "*/5 * * * *" check logs, at "2026-03-10T12:00:00Z" run report',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'remove',
          description: 'Remove a scheduled task',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Task id',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'toggle',
          description: 'Enable or disable a scheduled task',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Task id',
              required: true,
            },
          ],
        },
      ],
    },
  ];
}

export function parseSlashInteractionArgs(
  interaction: ChatInputCommandInteraction,
): string[] | null {
  if (!interaction.guildId && !isGlobalSlashCommand(interaction.commandName)) {
    return null;
  }

  switch (interaction.commandName) {
    case 'status':
      return ['status'];

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
      if (subcommand === 'info') return ['model', 'default'];
      if (subcommand === 'default') {
        const selectedModel = normalizeStringOption(interaction, 'name', true);
        return selectedModel ? ['model', 'default', selectedModel] : null;
      }
      return null;
    }

    case 'help':
      return ['help'];

    case 'bot': {
      const subcommand = normalizeSubcommand(interaction);
      if (subcommand === 'list' || subcommand === 'info') {
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

    case 'clear':
      return ['clear'];

    case 'usage': {
      const view = normalizeStringOption(interaction, 'view')?.toLowerCase();
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
      if (view !== 'model' || !agentId) {
        return ['usage', view];
      }
      return ['usage', 'model', agentId];
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
