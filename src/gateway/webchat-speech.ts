/**
 * Webchat speech boundary — turns one bounded text chunk into ephemeral audio.
 *
 * It uses the operator's provider credentials without exposing them or
 * retaining text/audio; the HTTP route owns authentication, request quota, and
 * delivery.
 *
 * Two backends, both speaking OpenAI's `/audio/speech` shape: HybridAI (the
 * default provider, so a signed-in operator needs no extra credential) and
 * OpenAI. HybridAI is tried first and OpenAI is the fallback, which also covers
 * the rollout window in which an operator's HybridAI deployment does not serve
 * the audio routes yet.
 *
 * NOT a voice-call or streaming-conversation runtime.
 */

import { readHybridAIApiKey } from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { logger } from '../logger.js';
import { readOpenAIAPIKey } from '../providers/openai.js';

export const MAX_WEBCHAT_SPEECH_CHARS = 4_096;

// TTS defaults (maintainer decision, 2026-07-29): configurable voices are
// deliberately deferred until HybridClaw has a general speech-output settings
// surface.
const WEBCHAT_SPEECH_MODEL = 'gpt-4o-mini-tts';
const WEBCHAT_SPEECH_VOICE = 'alloy';
const WEBCHAT_SPEECH_SPEED = 1.15;
const WEBCHAT_SPEECH_TIMEOUT_MS = 30_000;

interface SpeechBackend {
  provider: 'hybridai' | 'openai';
  endpoint: string;
  apiKey: string;
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Backends to try, in order. Empty when no provider is configured.
 *
 * HybridAI leads because it is the default provider; OpenAI follows so an
 * operator who configured both keeps working if HybridAI cannot serve the
 * request.
 */
function resolveSpeechBackends(): SpeechBackend[] {
  const backends: SpeechBackend[] = [];

  const hybridAIKey = readHybridAIApiKey();
  if (hybridAIKey) {
    backends.push({
      provider: 'hybridai',
      endpoint: `${trimBaseUrl(HYBRIDAI_BASE_URL)}/v1/audio/speech`,
      apiKey: hybridAIKey,
    });
  }

  const openAIKey = readOpenAIAPIKey({ required: false });
  if (openAIKey) {
    backends.push({
      provider: 'openai',
      endpoint: `${trimBaseUrl(getRuntimeConfig().openai.baseUrl)}/audio/speech`,
      apiKey: openAIKey,
    });
  }

  return backends;
}

export function isWebchatSpeechAvailable(): boolean {
  return resolveSpeechBackends().length > 0;
}

async function requestSpeech(
  backend: SpeechBackend,
  text: string,
  abortSignal: AbortSignal | undefined,
): Promise<Buffer> {
  const timeoutSignal = AbortSignal.timeout(WEBCHAT_SPEECH_TIMEOUT_MS);
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(backend.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: WEBCHAT_SPEECH_MODEL,
        voice: WEBCHAT_SPEECH_VOICE,
        input: text,
        response_format: 'mp3',
        speed: WEBCHAT_SPEECH_SPEED,
      }),
      signal,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new GatewayRequestError(504, 'Speech generation timed out.', {
        cause: error,
      });
    }
    if (abortSignal?.aborted) {
      throw new GatewayRequestError(499, 'Speech generation cancelled.', {
        cause: error,
      });
    }
    throw new GatewayRequestError(502, 'Speech generation failed.', {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new GatewayRequestError(502, 'Speech generation failed.');
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new GatewayRequestError(502, 'Speech generation returned no audio.');
  }
  return audio;
}

export async function synthesizeWebchatSpeech(params: {
  text: string;
  abortSignal?: AbortSignal;
}): Promise<Buffer> {
  const text = params.text.trim();
  if (!text) {
    throw new GatewayRequestError(400, 'Speech text is empty.');
  }
  if (text.length > MAX_WEBCHAT_SPEECH_CHARS) {
    throw new GatewayRequestError(
      413,
      `Speech text exceeds ${MAX_WEBCHAT_SPEECH_CHARS} characters.`,
    );
  }

  const backends = resolveSpeechBackends();
  if (backends.length === 0) {
    throw new GatewayRequestError(
      503,
      'Read aloud requires a HybridAI or OpenAI API key.',
    );
  }

  let lastError: unknown;
  for (const [index, backend] of backends.entries()) {
    try {
      return await requestSpeech(backend, text, params.abortSignal);
    } catch (error) {
      // A cancelled request is the user's decision, not a backend fault —
      // trying the next one would speak after they asked us to stop.
      if (error instanceof GatewayRequestError && error.statusCode === 499) {
        throw error;
      }
      lastError = error;
      const nextBackend = backends[index + 1];
      if (!nextBackend) break;
      logger.warn(
        { provider: backend.provider, next: nextBackend.provider },
        'Webchat speech backend failed; trying next backend',
      );
    }
  }

  throw lastError instanceof GatewayRequestError
    ? lastError
    : new GatewayRequestError(502, 'Speech generation failed.', {
        cause: lastError,
      });
}
