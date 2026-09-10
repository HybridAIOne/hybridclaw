/**
 * Discord command presentation bounds descriptions to Discord's API limit.
 * The canonical registry owns command semantics; this adapter only formats
 * Discord definitions and parses interactions, without registering commands.
 */
import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  type ChatInputCommandInteraction,
  InteractionContextType,
} from 'discord.js';
import {
  buildCanonicalSlashCommandDefinitions,
  type CanonicalSlashCommandDefinition,
  type CanonicalSlashCommandOptionDefinition,
  type CanonicalSlashStringOptionDefinition,
  parseCanonicalSlashCommandArgs,
} from '../../command-registry.js';

export interface SlashCommandDefinition {
  name: string;
  description: string;
  dmPermission?: boolean;
  integrationTypes?: readonly ApplicationIntegrationType[];
  contexts?: readonly InteractionContextType[];
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

function formatDescription(description: string): string {
  // Discord limits command, subcommand, and option descriptions to 100 characters.
  const characters = Array.from(description);
  if (characters.length <= 100) return description;
  return `${characters.slice(0, 97).join('').trimEnd()}...`;
}

function convertStringOption(
  option: CanonicalSlashStringOptionDefinition,
): SlashCommandStringOptionDefinition {
  return {
    type: ApplicationCommandOptionType.String,
    name: option.name,
    description: formatDescription(option.description),
    required: option.required,
    choices: option.choices,
  };
}

function convertOption(
  option: CanonicalSlashCommandOptionDefinition,
): SlashCommandOptionDefinition {
  if (option.kind === 'string') {
    return convertStringOption(option);
  }

  return {
    type: ApplicationCommandOptionType.Subcommand,
    name: option.name,
    description: formatDescription(option.description),
    options: option.options?.map(convertStringOption),
  };
}

function convertDefinition(
  definition: CanonicalSlashCommandDefinition,
): SlashCommandDefinition {
  return {
    name: definition.name,
    description: formatDescription(definition.description),
    options: definition.options?.map(convertOption),
  };
}

export function isGlobalSlashCommand(name: string): boolean {
  void name;
  return true;
}

export function buildSlashCommandDefinitions(
  modelChoices: Array<{ name: string; value: string }>,
): SlashCommandDefinition[] {
  return buildCanonicalSlashCommandDefinitions(modelChoices)
    .map(convertDefinition)
    .map((definition) => ({
      ...definition,
      integrationTypes: [ApplicationIntegrationType.GuildInstall],
      contexts: [
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ],
    }));
}

export function parseSlashInteractionArgs(
  interaction: ChatInputCommandInteraction,
): string[] | null {
  if (!interaction.guildId && !isGlobalSlashCommand(interaction.commandName)) {
    return null;
  }

  return parseCanonicalSlashCommandArgs({
    commandName: interaction.commandName,
    getString: (name, required = false) =>
      interaction.options.getString(name, required)?.trim() ?? null,
    getSubcommand: () =>
      interaction.options.getSubcommand(false)?.trim().toLowerCase() ?? null,
  });
}
