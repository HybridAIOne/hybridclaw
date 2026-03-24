import { triggerDiscordMediaCacheCleanup } from '../channels/discord/media-cache.js';
import { logger } from '../logger.js';
import { cleanupManagedTempMediaDirectories } from '../media/managed-temp-media.js';
import { startUploadedMediaCacheCleanup } from '../media/uploaded-media-cache.js';

export async function runManagedMediaCleanup(
  reason: 'startup' | 'shutdown',
): Promise<void> {
  const discordTask = triggerDiscordMediaCacheCleanup({ force: true });
  const uploadedMediaTask = startUploadedMediaCacheCleanup({ force: true });
  const managedTempTask =
    reason === 'startup' ? cleanupManagedTempMediaDirectories() : null;

  const [discordCleanup, uploadedMediaCleanup, managedTempCleanup] =
    await Promise.allSettled([
      discordTask ?? Promise.resolve(),
      uploadedMediaTask ?? Promise.resolve(),
      managedTempTask ?? Promise.resolve(),
    ]);

  if (discordTask && discordCleanup.status === 'rejected') {
    logger.warn(
      { error: discordCleanup.reason, reason },
      'Discord media cache cleanup failed',
    );
  }
  if (uploadedMediaTask && uploadedMediaCleanup.status === 'rejected') {
    logger.warn(
      { error: uploadedMediaCleanup.reason, reason },
      'Uploaded media cache cleanup failed',
    );
  }
  if (managedTempTask && managedTempCleanup.status === 'rejected') {
    logger.warn(
      { error: managedTempCleanup.reason, reason },
      'Managed temp media cleanup failed',
    );
  }
}
