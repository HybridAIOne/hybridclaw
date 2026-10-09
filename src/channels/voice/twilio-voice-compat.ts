/**
 * Upgrade shims for installs from before Twilio voice became the bundled
 * `twilio-voice` plugin. compat: remove after v0.41
 *
 * - `/voice/webhook`, the URL v0.39 had operators set on their Twilio numbers,
 *   still reaches the plugin's incoming-call webhook. The request keeps the
 *   URL Twilio called, because Twilio signs that URL; the TwiML the plugin
 *   answers with points every later request at the plugin's own paths, so
 *   only this entry point needs an alias.
 * - At startup, `voice.enabled` without a loaded plugin (disabled, removed, or
 *   failing) logs one warning instead of letting calls fail silently; with the
 *   plugin loaded, the startup channel log reports voice as active.
 *
 * NOT a runtime: core serves no calls; the plugin owns every route and socket.
 * The config migration that enables the plugin is
 * `src/config/legacy-twilio-voice.ts`.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { buildPluginInboundWebhookPath } from '../../plugins/plugin-webhooks.js';
import {
  readTwilioVoicePluginState,
  TWILIO_VOICE_PLUGIN_ID,
} from './twilio-voice-plugin-state.js';

const LEGACY_WEBHOOK_PATH = '/voice/webhook';
const PLUGIN_WEBHOOK_PATH = buildPluginInboundWebhookPath(
  TWILIO_VOICE_PLUGIN_ID,
  'webhook',
);

let legacyWebhookWarned = false;

export function isLegacyTwilioVoiceWebhookPath(pathname: string): boolean {
  return pathname === LEGACY_WEBHOOK_PATH;
}

/** The plugin webhook path a legacy `/voice/webhook` request is served by. */
export function resolveLegacyTwilioVoiceWebhookPath(
  pathname: string,
): string | null {
  if (!isLegacyTwilioVoiceWebhookPath(pathname)) return null;
  if (!legacyWebhookWarned) {
    legacyWebhookWarned = true;
    logger.warn(
      { legacyPath: LEGACY_WEBHOOK_PATH, webhookPath: PLUGIN_WEBHOOK_PATH },
      'Twilio called the pre-v0.40 /voice/webhook URL; it is served by the twilio-voice plugin through v0.41, so point the number at /api/plugin-webhooks/twilio-voice/webhook',
    );
  }
  return PLUGIN_WEBHOOK_PATH;
}

/** Whether Twilio calls are answered: `voice.enabled` and the plugin loaded. */
export async function warnIfTwilioVoicePluginMissing(): Promise<boolean> {
  const config = getConfigSnapshot();
  if (!config.voice.enabled) return false;
  const plugin = readTwilioVoicePluginState();
  if (plugin.loaded) return true;
  logger.warn(
    {
      pluginId: TWILIO_VOICE_PLUGIN_ID,
      pluginError: plugin.error,
      installCommand: `hybridclaw plugin install ${TWILIO_VOICE_PLUGIN_ID}`,
      webhookPath: PLUGIN_WEBHOOK_PATH,
    },
    plugin.error
      ? 'voice.enabled is set but the twilio-voice plugin failed to load; Twilio calls are not answered until it loads'
      : 'voice.enabled is set but the twilio-voice plugin is not enabled; Twilio calls are not answered until you run `hybridclaw plugin install twilio-voice` (or `plugin enable twilio-voice`)',
  );
  return false;
}
