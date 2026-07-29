/**
 * Webchat speech boundary — turns one bounded text chunk into ephemeral audio.
 *
 * It uses the operator's OpenAI credentials without exposing them or retaining
 * text/audio; the HTTP route owns authentication, request quota, and delivery.
 *
 * NOT a voice-call or streaming-conversation runtime.
 */

import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { readOpenAIAPIKey } from '../providers/openai.js';

export const MAX_WEBCHAT_SPEECH_CHARS = 4_096;

// TTS defaults (maintainer decision, 2026-07-29): configurable voices are
// deliberately deferred until HybridClaw has a general speech-output settings
// surface.
const WEBCHAT_SPEECH_MODEL = 'gpt-4o-mini-tts';
const WEBCHAT_SPEECH_VOICE = 'alloy';
const WEBCHAT_SPEECH_SPEED = 1.15;
const WEBCHAT_SPEECH_TIMEOUT_MS = 30_000;

function speechEndpoint(): string {
  const baseUrl = getRuntimeConfig().openai.baseUrl.trim().replace(/\/+$/, '');
  return `${baseUrl}/audio/speech`;
}

export function isWebchatSpeechAvailable(): boolean {
  return Boolean(readOpenAIAPIKey({ required: false }));
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

  const apiKey = readOpenAIAPIKey({ required: false });
  if (!apiKey) {
    throw new GatewayRequestError(
      503,
      'Read aloud requires an OpenAI API key.',
    );
  }

  const timeoutSignal = AbortSignal.timeout(WEBCHAT_SPEECH_TIMEOUT_MS);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(speechEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    if (params.abortSignal?.aborted) {
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
