/**
 * Managed temp-media directories: the OS-temp directory prefixes channel
 * downloads land under, read by the gateway and the host-mode agent alike.
 *
 * A path is readable as attachment media only inside a directory whose name
 * starts with one of these prefixes. The list is the single allowlist; the
 * gateway's path resolution and cleanup live in `src/media/`, not here.
 */

export const WHATSAPP_MEDIA_TMP_PREFIX = 'hybridclaw-wa-';
export const SLACK_MEDIA_TMP_PREFIX = 'hybridclaw-slack-';

export const MANAGED_TEMP_MEDIA_DIR_PREFIXES: readonly string[] = [
  WHATSAPP_MEDIA_TMP_PREFIX,
  SLACK_MEDIA_TMP_PREFIX,
];

export function isManagedTempMediaDirName(
  name: string,
  prefixes: readonly string[] = MANAGED_TEMP_MEDIA_DIR_PREFIXES,
): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}
