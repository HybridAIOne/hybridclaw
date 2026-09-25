import { runAudioTranscribe } from './audio-transcribe.js';
import { runImageGenerate } from './image-generation.js';
import { MEDIA_TOOL_DEFINITIONS } from './tool-definitions.js';
import { runVideoGenerate } from './video-generation.js';

const RUNNERS = {
  image_generate: runImageGenerate,
  audio_transcribe: runAudioTranscribe,
  video_generate: runVideoGenerate,
};

function credential(api, ...names) {
  for (const name of names) {
    const value = api.getCredential(name);
    if (value) return value;
  }
  return '';
}

function providerEntry(fields) {
  if (!fields.apiKey) return undefined;
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => Boolean(value)),
  );
}

// Dedicated provider keys, read per call so `/secret set` applies without a
// reload. Gemini and xAI base URLs come from the matching core provider config.
function resolveProviderCredentials(api) {
  return {
    speechToText: {
      defaultProvider: api.config.skills?.speechToText?.defaultProvider,
    },
    openai: providerEntry({
      apiKey: credential(api, 'OPENAI_API_KEY'),
      baseUrl: credential(api, 'OPENAI_BASE_URL'),
      audioModel: credential(api, 'OPENAI_AUDIO_MODEL'),
      imageModel: credential(api, 'OPENAI_IMAGE_MODEL'),
      videoModel: credential(api, 'OPENAI_VIDEO_MODEL'),
    }),
    gemini: providerEntry({
      apiKey: credential(api, 'GEMINI_API_KEY', 'GOOGLE_API_KEY'),
      baseUrl: api.config.gemini?.baseUrl,
      imageModel: credential(api, 'GEMINI_IMAGE_MODEL'),
      videoModel: credential(api, 'GEMINI_VIDEO_MODEL'),
    }),
    xai: providerEntry({
      apiKey: credential(api, 'XAI_API_KEY'),
      baseUrl: api.config.xai?.baseUrl,
      imageModel: credential(api, 'XAI_IMAGE_MODEL'),
    }),
    bfl: providerEntry({
      apiKey: credential(api, 'BFL_API_KEY', 'BLACK_FOREST_LABS_API_KEY'),
      baseUrl: credential(api, 'BFL_BASE_URL'),
      imageModel: credential(api, 'BFL_IMAGE_MODEL'),
    }),
    deepgram: providerEntry({
      apiKey: credential(api, 'DEEPGRAM_API_KEY'),
      baseUrl: credential(api, 'DEEPGRAM_BASE_URL'),
      audioModel: credential(api, 'DEEPGRAM_AUDIO_MODEL'),
    }),
    assemblyai: providerEntry({
      apiKey: credential(api, 'ASSEMBLYAI_API_KEY'),
      baseUrl: credential(api, 'ASSEMBLYAI_BASE_URL'),
      audioModel: credential(api, 'ASSEMBLYAI_AUDIO_MODEL'),
    }),
  };
}

async function resolveSessionModel(api, toolContext) {
  try {
    return await api.media.getSessionModelCredentials(toolContext.sessionId);
  } catch (error) {
    // Without session credentials the tools still use dedicated provider keys.
    toolContext.logger.debug(
      { error },
      'media-tools: session model credentials unavailable',
    );
    return { provider: '', model: '', baseUrl: '', apiKey: '' };
  }
}

async function buildRuntimeContext(api, toolContext) {
  const { sessionId, media } = toolContext;
  return {
    ...(await resolveSessionModel(api, toolContext)),
    providerCredentials: resolveProviderCredentials(api),
    media,
    workspaceRoot: api.getSessionInfo(sessionId).workspaceRoot,
    workspaceDisplayRoot: api.media.workspaceDisplayRoot,
    resolveInputPath: (rawPath) =>
      api.media.resolveInputPath(sessionId, rawPath, media),
    fetchRemote: (url, options) => api.media.fetchRemote(url, options),
  };
}

export default {
  id: 'media-tools',
  register(api) {
    for (const definition of MEDIA_TOOL_DEFINITIONS) {
      const run = RUNNERS[definition.name];
      api.registerTool({
        ...definition,
        async handler(args, toolContext) {
          try {
            return await run(args, await buildRuntimeContext(api, toolContext));
          } catch (error) {
            throw new Error(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      });
    }
  },
};
