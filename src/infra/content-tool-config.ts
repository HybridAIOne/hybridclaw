import { readStoredRuntimeSecrets } from '../security/runtime-secrets.js';
import type { ContentToolConfig } from '../types/container.js';

const DEFAULT_FAL_BASE_URL = 'https://fal.run';
const DEFAULT_FAL_IMAGE_MODEL = 'fal-ai/flux-2/klein/9b';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_OPENAI_TTS_VOICE = 'alloy';
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';
const DEFAULT_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const normalized = String(value || '').trim() || fallback;
  return normalized.replace(/\/+$/, '');
}

function readSecret(name: string): string {
  const storedSecrets = readStoredRuntimeSecrets();
  return (
    String(process.env[name] || '').trim() ||
    String(storedSecrets[name] || '').trim()
  );
}

export function resolveContentToolConfig(): ContentToolConfig {
  const openAiBaseUrl = normalizeBaseUrl(
    process.env.OPENAI_BASE_URL,
    DEFAULT_OPENAI_BASE_URL,
  );

  return {
    imageGeneration: {
      apiKey: readSecret('FAL_API_KEY'),
      baseUrl: normalizeBaseUrl(process.env.FAL_BASE_URL, DEFAULT_FAL_BASE_URL),
      defaultModel: DEFAULT_FAL_IMAGE_MODEL,
      defaultCount: 1,
      defaultAspectRatio: '1:1',
      defaultResolution: '1K',
      defaultOutputFormat: 'png',
      timeoutMs: 120_000,
    },
    speech: {
      apiKey: readSecret('OPENAI_API_KEY'),
      baseUrl: openAiBaseUrl,
      defaultModel: DEFAULT_OPENAI_TTS_MODEL,
      defaultVoice: DEFAULT_OPENAI_TTS_VOICE,
      defaultOutputFormat: 'mp3',
      defaultSpeed: 1,
      maxChars: 4_000,
      timeoutMs: 60_000,
    },
    transcription: {
      apiKey: readSecret('OPENAI_API_KEY'),
      baseUrl: openAiBaseUrl,
      defaultModel: DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
      defaultLanguage: '',
      defaultPrompt: '',
      maxBytes: DEFAULT_TRANSCRIPTION_MAX_BYTES,
      timeoutMs: 120_000,
    },
  };
}
