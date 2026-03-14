import { triggerDiscordMediaCacheCleanup } from '../channels/discord/media-cache.js';
import { logger } from '../logger.js';
import { cleanupManagedTempMediaDirectories } from '../media/managed-temp-media.js';

export async function runManagedMediaCleanup(
  reason: 'startup' | 'shutdown',
): Promise<void> {
  const discordTask = triggerDiscordMediaCacheCleanup({ force: true });
  const managedTempTask =
    reason === 'startup' ? cleanupManagedTempMediaDirectories() : null;

  const [discordCleanup, managedTempCleanup] = await Promise.allSettled([
    discordTask ?? Promise.resolve(),
    managedTempTask ?? Promise.resolve(),
  ]);

  if (discordTask && discordCleanup.status === 'rejected') {
    logger.warn(
      { error: discordCleanup.reason, reason },
      'Discord media cache cleanup failed',
    );
  }
  if (managedTempTask && managedTempCleanup.status === 'rejected') {
    logger.warn(
      { error: managedTempCleanup.reason, reason },
      'Managed temp media cleanup failed',
    );
  }
}
