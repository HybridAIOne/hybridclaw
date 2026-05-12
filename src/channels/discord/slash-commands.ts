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
  dmPermission?: boolean | undefined;
  integrationTypes?: readonly ApplicationIntegrationType[] | undefined;
  contexts?: readonly InteractionContextType[] | undefined;
  options?: SlashCommandOptionDefinition[] | undefined;
}

type SlashCommandStringOptionDefinition = {
  type: ApplicationCommandOptionType.String;
  name: string;
  description: string;
  required?: boolean | undefined;
  choices?: Array<{ name: string; value: string }> | undefined;
};

type SlashCommandSubcommandOptionDefinition = {
  type: ApplicationCommandOptionType.Subcommand;
  name: string;
  description: string;
  options?: SlashCommandStringOptionDefinition[] | undefined;
};

export type SlashCommandOptionDefinition =
  | SlashCommandStringOptionDefinition
  | SlashCommandSubcommandOptionDefinition;

function convertStringOption(
  option: CanonicalSlashStringOptionDefinition,
): SlashCommandStringOptionDefinition {
  return {
    type: ApplicationCommandOptionType.String,
    name: option.name,
    description: option.description,
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
    description: option.description,
    options: option.options?.map(convertStringOption),
  };
}

function convertDefinition(
  definition: CanonicalSlashCommandDefinition,
): SlashCommandDefinition {
  return {
    name: definition.name,
    description: definition.description,
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
