/**
 * Upgrade notice for configs written before Twilio voice became the
 * `twilio-voice` plugin: `voice.enabled` used to start a built-in runtime,
 * and now does nothing until the plugin is installed. Says so once at
 * startup, with the install command and the new webhook URL, instead of
 * letting calls fail silently.
 *
 * NOT a runtime: it never serves calls and always reports the channel as
 * not started by core.
 * compat: remove after v0.41
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { getPluginManager } from '../../plugins/plugin-manager.js';

const TWILIO_VOICE_PLUGIN_ID = 'twilio-voice';

export async function warnIfTwilioVoicePluginMissing(): Promise<false> {
  const config = getConfigSnapshot();
  if (!config.voice.enabled) return false;
  const plugin = getPluginManager()
    .listPluginSummary()
    .find((summary) => summary.id === TWILIO_VOICE_PLUGIN_ID);
  if (plugin?.enabled && !plugin.error) return false;
  logger.warn(
    {
      pluginId: TWILIO_VOICE_PLUGIN_ID,
      pluginError: plugin?.error || null,
      installCommand: `hybridclaw plugin install ${TWILIO_VOICE_PLUGIN_ID}`,
      webhookPath: `/api/plugin-webhooks/${TWILIO_VOICE_PLUGIN_ID}/webhook`,
    },
    plugin
      ? 'voice.enabled is set but the twilio-voice plugin failed to load; Twilio calls are not answered until it loads'
      : 'voice.enabled is set but Twilio voice now ships as the twilio-voice plugin; install it with `hybridclaw plugin install twilio-voice` and point the Twilio number at /api/plugin-webhooks/twilio-voice/webhook',
  );
  return false;
}
