/**
 * One-time move of built-in Twilio voice onto the bundled `twilio-voice`
 * plugin. compat: remove after v0.41
 *
 * A config below schema v41 with `voice.enabled: true` relied on the gateway
 * answering Twilio calls itself, so it gains an enabled `twilio-voice` entry
 * with no path: the plugin manager then loads the copy shipped in the package,
 * with no install step. Configs at v41 or later are never touched, so an
 * operator who removes or disables the entry keeps that choice.
 *
 * NOT the plugin loader, and NOT the `/voice/webhook` alias
 * (`src/channels/voice/twilio-voice-compat.ts`).
 */
import type { RuntimePluginsConfig } from './runtime-config.js';

const TWILIO_VOICE_PLUGIN_SCHEMA_VERSION = 41;
const TWILIO_VOICE_PLUGIN_ID = 'twilio-voice';

export function withLegacyTwilioVoicePlugin(
  plugins: RuntimePluginsConfig,
  source: { version: number | null; voiceEnabled: boolean },
): RuntimePluginsConfig {
  if (
    !source.voiceEnabled ||
    (source.version !== null &&
      source.version >= TWILIO_VOICE_PLUGIN_SCHEMA_VERSION) ||
    plugins.list.some((entry) => entry.id === TWILIO_VOICE_PLUGIN_ID)
  ) {
    return plugins;
  }
  return {
    list: [
      ...plugins.list,
      { id: TWILIO_VOICE_PLUGIN_ID, enabled: true, config: {} },
    ],
  };
}
