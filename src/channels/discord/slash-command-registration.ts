/**
 * Slash-command registration isolates failures to individual global commands.
 * Guild copies are removed only after their global replacement succeeds.
 * Unlike slash-commands.ts, this module performs API writes, not presentation.
 */
import type { ApplicationCommandDataResolvable, Client } from 'discord.js';
import { logger } from '../../logger.js';
import type { SlashCommandDefinition } from './slash-commands.js';
import { logDiscordApiError } from './transport-errors.js';

export async function registerSlashCommands(
  client: Pick<Client, 'application' | 'guilds'>,
  definitions: readonly SlashCommandDefinition[],
): Promise<void> {
  const application = client.application;
  if (!application) return;

  const registeredNames = new Set<string>();
  // Keep global upserts sequential to avoid a startup burst on the shared route.
  for (const definition of definitions) {
    try {
      // POST is an upsert by name. Keep IDs stable for cached DM commands.
      await application.commands.create(
        definition as unknown as ApplicationCommandDataResolvable,
      );
      registeredNames.add(definition.name);
      logger.debug(
        { scope: 'global', command: definition.name },
        'Upserted slash command',
      );
    } catch (error) {
      logDiscordApiError({
        error,
        expectedAction: `Global slash command /${definition.name} was not registered; continuing with remaining commands.`,
        unexpectedMessage: 'Failed to register global slash command',
        metadata: { scope: 'global', command: definition.name },
      });
    }
  }

  const failedCount = definitions.length - registeredNames.size;
  if (failedCount > 0) {
    logger.warn(
      { scope: 'global', count: registeredNames.size, failedCount },
      'Slash command registration completed with failures',
    );
  } else {
    logger.info(
      { scope: 'global', count: registeredNames.size },
      'Successfully registered slash commands',
    );
  }

  if (registeredNames.size === 0) return;
  await Promise.allSettled(
    [...client.guilds.cache.values()].map(async (guild) => {
      try {
        const refreshed = await guild.commands.fetch();
        let removedCount = 0;
        for (const command of refreshed.values()) {
          if (!registeredNames.has(command.name)) continue;
          await guild.commands.delete(command.id);
          removedCount += 1;
          logger.debug(
            { guildId: guild.id, command: command.name },
            'Removed guild slash command',
          );
        }
        logger.info(
          { guildId: guild.id, count: removedCount },
          'Successfully cleaned up guild slash commands',
        );
      } catch (error) {
        logDiscordApiError({
          error,
          expectedAction: 'Guild slash commands were not cleaned up.',
          unexpectedMessage: 'Failed to clean up Discord guild slash commands',
          metadata: { guildId: guild.id },
        });
      }
    }),
  );
}
