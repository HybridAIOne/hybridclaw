// Provider selection stays in the plugin: only configured credentials and their
// matching endpoints become candidates. HybridAI chat routing headers do not
// apply to the platform's fixed audio service.
import {
  normalizeBaseUrl,
  readCredentialValue,
  stripProviderPrefix,
} from './shared.js';

const DEFAULT_HYBRIDAI_AUDIO_MODEL = 'gpt-4o-mini-transcribe';
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com/v1';
const DEFAULT_ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';
const DEFAULT_OPENAI_AUDIO_MODEL = 'whisper-1';
const DEFAULT_DEEPGRAM_AUDIO_MODEL = 'nova-3';
const DEFAULT_ASSEMBLYAI_AUDIO_MODEL = 'universal';
function hasAudioTranscriptionModelHint(model) {
  return /whisper|transcribe|transcription/i.test(model);
}
function normalizeSpeechToTextProvider(value) {
  const normalized = readCredentialValue(value).toLowerCase();
  if (normalized === 'whisper' || normalized === 'openai-whisper') {
    return 'openai';
  }
  return normalized === 'hybridai' ||
    normalized === 'openai' ||
    normalized === 'deepgram' ||
    normalized === 'assemblyai'
    ? normalized
    : null;
}
function candidateFromCurrentContext(context) {
  if (!context.apiKey || context.provider !== 'openai-codex') return null;
  const model = stripProviderPrefix(context.model, 'openai-codex');
  return {
    id: 'openai',
    label: 'OpenAI / Codex',
    apiKey: context.apiKey,
    baseUrl: normalizeBaseUrl(context.baseUrl, DEFAULT_OPENAI_BASE_URL),
    model: hasAudioTranscriptionModelHint(model)
      ? model
      : DEFAULT_OPENAI_AUDIO_MODEL,
    requestHeaders: context.requestHeaders,
    maxAudioBytes: MAX_AUDIO_BYTES,
    supportsDiarization: false,
    supportsWordTimestamps: true,
    supportsLanguageDetection: true,
  };
}
export function buildProviderCandidates(context, providerOverride) {
  const hybridai =
    context.provider === 'hybridai' && context.apiKey
      ? context
      : context.providerCredentials?.hybridai;
  const candidates =
    hybridai?.apiKey && hybridai.baseUrl
      ? [
          {
            id: 'hybridai',
            label: 'HybridAI',
            apiKey: hybridai.apiKey,
            baseUrl: `${normalizeBaseUrl(hybridai.baseUrl, '').replace(/\/v1$/, '')}/v1`,
            model: DEFAULT_HYBRIDAI_AUDIO_MODEL,
            maxAudioBytes: MAX_AUDIO_BYTES,
            supportsDiarization: false,
            supportsWordTimestamps: false,
            supportsLanguageDetection: false,
          },
        ]
      : [];
  const openaiConfig = context.providerCredentials?.openai || {};
  const openaiKey = readCredentialValue(openaiConfig.apiKey);
  const current = candidateFromCurrentContext(context);
  if (current) candidates.push(current);
  if (openaiKey && !candidates.some((entry) => entry.id === 'openai')) {
    candidates.push({
      id: 'openai',
      label: 'OpenAI',
      apiKey: openaiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(openaiConfig.baseUrl),
        DEFAULT_OPENAI_BASE_URL,
      ),
      model:
        readCredentialValue(openaiConfig.audioModel) ||
        DEFAULT_OPENAI_AUDIO_MODEL,
      maxAudioBytes: MAX_AUDIO_BYTES,
      supportsDiarization: false,
      supportsWordTimestamps: true,
      supportsLanguageDetection: true,
    });
  }
  const deepgramConfig = context.providerCredentials?.deepgram || {};
  const deepgramKey = readCredentialValue(deepgramConfig.apiKey);
  if (deepgramKey) {
    candidates.push({
      id: 'deepgram',
      label: 'Deepgram',
      apiKey: deepgramKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(deepgramConfig.baseUrl),
        DEFAULT_DEEPGRAM_BASE_URL,
      ),
      model:
        readCredentialValue(deepgramConfig.audioModel) ||
        DEFAULT_DEEPGRAM_AUDIO_MODEL,
      maxAudioBytes: 512 * 1024 * 1024,
      supportsDiarization: true,
      supportsWordTimestamps: true,
      supportsLanguageDetection: true,
    });
  }
  const assemblyaiConfig = context.providerCredentials?.assemblyai || {};
  const assemblyaiKey = readCredentialValue(assemblyaiConfig.apiKey);
  if (assemblyaiKey) {
    candidates.push({
      id: 'assemblyai',
      label: 'AssemblyAI',
      apiKey: assemblyaiKey,
      baseUrl: normalizeBaseUrl(
        readCredentialValue(assemblyaiConfig.baseUrl),
        DEFAULT_ASSEMBLYAI_BASE_URL,
      ),
      model:
        readCredentialValue(assemblyaiConfig.audioModel) ||
        DEFAULT_ASSEMBLYAI_AUDIO_MODEL,
      maxAudioBytes: 512 * 1024 * 1024,
      supportsDiarization: true,
      supportsWordTimestamps: true,
      supportsLanguageDetection: true,
    });
  }
  const requested = String(providerOverride || 'auto')
    .trim()
    .toLowerCase();
  if (!requested || requested === 'auto' || requested === 'default') {
    const defaultProvider = normalizeSpeechToTextProvider(
      context.providerCredentials?.speechToText?.defaultProvider,
    );
    if (defaultProvider) {
      return [
        ...candidates.filter((candidate) => candidate.id === defaultProvider),
        ...candidates.filter((candidate) => candidate.id !== defaultProvider),
      ];
    }
    return candidates;
  }
  const normalized =
    requested === 'whisper' || requested === 'openai-whisper'
      ? 'openai'
      : requested;
  return candidates.filter((candidate) => candidate.id === normalized);
}
export function listAudioTranscriptionProviders(context) {
  const candidates = buildProviderCandidates(context);
  const ready = new Set(candidates.map((entry) => entry.id));
  const active = candidateFromCurrentContext(context)?.id || null;
  const candidateById = new Map(candidates.map((entry) => [entry.id, entry]));
  return {
    success: true,
    configured_count: candidates.length,
    default_provider: candidates[0]?.id || null,
    providers: [
      {
        id: 'hybridai',
        label: 'HybridAI',
        ready: ready.has('hybridai'),
        active: context.provider === 'hybridai' && ready.has('hybridai'),
        model: DEFAULT_HYBRIDAI_AUDIO_MODEL,
        missing: ready.has('hybridai')
          ? null
          : 'Sign in to HybridAI or configure HYBRIDAI_API_KEY.',
        capabilities: {
          language_detection: false,
          segment_timestamps: false,
          word_timestamps: false,
          diarization: false,
        },
      },
      {
        id: 'openai',
        label: 'OpenAI Whisper',
        ready: ready.has('openai'),
        active: active === 'openai',
        model:
          candidates.find((entry) => entry.id === 'openai')?.model ||
          DEFAULT_OPENAI_AUDIO_MODEL,
        missing: ready.has('openai')
          ? null
          : 'Store OPENAI_API_KEY with `hybridclaw secret set OPENAI_API_KEY <key>` or in TUI with `/secret set OPENAI_API_KEY <key>`, or use an openai-codex model with credentials.',
        capabilities: {
          language_detection: true,
          segment_timestamps: true,
          word_timestamps: true,
          diarization: false,
        },
      },
      {
        id: 'deepgram',
        label: 'Deepgram',
        ready: ready.has('deepgram'),
        active: false,
        model:
          candidateById.get('deepgram')?.model || DEFAULT_DEEPGRAM_AUDIO_MODEL,
        missing: ready.has('deepgram')
          ? null
          : 'Store DEEPGRAM_API_KEY with `hybridclaw secret set DEEPGRAM_API_KEY <key>` or in TUI with `/secret set DEEPGRAM_API_KEY <key>`.',
        capabilities: {
          language_detection: true,
          segment_timestamps: true,
          word_timestamps: true,
          diarization: true,
        },
      },
      {
        id: 'assemblyai',
        label: 'AssemblyAI',
        ready: ready.has('assemblyai'),
        active: false,
        model:
          candidateById.get('assemblyai')?.model ||
          DEFAULT_ASSEMBLYAI_AUDIO_MODEL,
        missing: ready.has('assemblyai')
          ? null
          : 'Store ASSEMBLYAI_API_KEY with `hybridclaw secret set ASSEMBLYAI_API_KEY <key>` or in TUI with `/secret set ASSEMBLYAI_API_KEY <key>`.',
        capabilities: {
          language_detection: true,
          segment_timestamps: true,
          word_timestamps: true,
          diarization: true,
        },
      },
    ],
  };
}
