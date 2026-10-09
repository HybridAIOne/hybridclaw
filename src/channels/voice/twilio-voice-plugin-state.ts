/**
 * Whether the `twilio-voice` plugin is loaded in this gateway: enabled and
 * registered without a load error. Core answers no Twilio traffic itself, so
 * this is the fact `gateway status`, the console Voice card, and the startup
 * channel log read before reporting phone calls as answerable.
 *
 * NOT whether calls can be answered right now (the plugin's own
 * `unavailableReason` also checks credentials and `voice.enabled`).
 */
import { getPluginManager } from '../../plugins/plugin-manager.js';

export const TWILIO_VOICE_PLUGIN_ID = 'twilio-voice';

export function readTwilioVoicePluginState(): {
  loaded: boolean;
  error: string | null;
} {
  const plugin = getPluginManager()
    .listPluginSummary()
    .find((summary) => summary.id === TWILIO_VOICE_PLUGIN_ID);
  return {
    loaded: Boolean(plugin?.enabled && !plugin.error),
    error: plugin?.error || null,
  };
}
