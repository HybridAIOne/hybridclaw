/**
 * Resolves which upstream serves realtime voice sessions.
 *
 * `voice.realtime.provider` selects between OpenAI directly (`openai`, the
 * default, using OPENAI_API_KEY) and the HybridAI platform's `/v1/realtime`
 * proxy (`hybridai`, using the signed-in HybridAI credential and
 * HYBRIDAI_BASE_URL). Both speak the same realtime protocol, so everything
 * past the connection URL and bearer token is provider-agnostic.
 *
 * Shared by the Twilio phone path and the web console path so the two
 * surfaces cannot drift on provider selection or error wording.
 */
import { readHybridAIApiKey } from '../../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL, OPENAI_API_KEY } from '../../config/config.js';
import type { RuntimeVoiceRealtimeProvider } from '../../config/runtime-config.js';

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export interface RealtimeConnection {
  url: string;
  apiKey: string;
}

export function hybridaiRealtimeUrl(baseUrl: string): string {
  const trimmed = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const wsBase = trimmed
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
  return `${wsBase}/v1/realtime`;
}

/**
 * The connection for the configured provider, or an explanation of the
 * missing credential. Never throws: both call sites report the error into a
 * live socket rather than to a caller that could recover.
 */
export function resolveRealtimeConnection(
  provider: RuntimeVoiceRealtimeProvider,
):
  | { connection: RealtimeConnection; error: null }
  | {
      connection: null;
      error: string;
    } {
  if (provider === 'hybridai') {
    const apiKey = String(readHybridAIApiKey() || '').trim();
    if (!apiKey) {
      return {
        connection: null,
        error:
          'Realtime voice via the hybridai provider requires a HybridAI API key (sign in or set HYBRIDAI_API_KEY).',
      };
    }
    return {
      connection: { url: hybridaiRealtimeUrl(HYBRIDAI_BASE_URL), apiKey },
      error: null,
    };
  }
  const apiKey = String(OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return {
      connection: null,
      error: 'Realtime voice requires an OpenAI API key (OPENAI_API_KEY).',
    };
  }
  return { connection: { url: OPENAI_REALTIME_URL, apiKey }, error: null };
}

export function isRealtimeCredentialConfigured(
  provider: RuntimeVoiceRealtimeProvider,
): boolean {
  return resolveRealtimeConnection(provider).connection !== null;
}
