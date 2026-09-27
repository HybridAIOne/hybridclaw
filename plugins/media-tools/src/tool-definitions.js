// Schemas the agent sees for the media tools; names and argument shapes match
// the former sandbox tools so approval tiers, usage accounting, and
// transcript memory keep keying on them.
export const MEDIA_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'image_generate',
      description:
        'Generate or edit deliverable images with a configured image provider. Use action="list" to inspect provider readiness. Do not use for image analysis; use vision_analyze for that.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list'],
            description:
              'Use "list" to show configured image generation providers instead of generating.',
          },
          prompt: {
            type: 'string',
            description: 'Image generation or editing prompt.',
          },
          image: {
            type: ['string', 'array'],
            description:
              'Optional reference image path or list of paths from /workspace, /discord-media-cache, /uploaded-media-cache, or a Discord CDN HTTPS URL.',
            items: { type: 'string' },
          },
          images: {
            type: 'array',
            description:
              'Optional reference image paths from /workspace, /discord-media-cache, /uploaded-media-cache, or Discord CDN HTTPS URLs.',
            items: { type: 'string' },
          },
          aspectRatio: {
            type: 'string',
            description:
              'Optional aspect ratio such as 1:1, 3:2, 2:3, landscape, portrait, or square.',
          },
          quality: {
            type: 'string',
            description:
              'Optional quality hint. Unsupported provider values are reported as warnings.',
          },
          size: {
            type: 'string',
            description:
              'Optional provider size or resolution such as 1024x1024.',
          },
          resolution: {
            type: 'string',
            description: 'Alias for size.',
          },
          count: {
            type: 'number',
            description: 'Number of images to generate, capped at 4.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'audio_transcribe',
      description:
        'Transcribe an audio attachment, local audio file, or HTTPS audio URL with a configured speech-to-text provider. Use action="list" to inspect provider readiness.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'detect-language'],
            description:
              'Use "list" to show configured speech-to-text providers, or "detect-language" to identify the dominant spoken language.',
          },
          provider: {
            type: 'string',
            description:
              'Optional provider override: auto, openai, whisper, deepgram, or assemblyai.',
          },
          audio: {
            type: 'string',
            description:
              'Audio path, attachment filename/ref, or HTTPS URL. If omitted, exactly one current audio attachment is used.',
          },
          audio_url: {
            type: 'string',
            description: 'Alias for audio when passing an HTTPS audio URL.',
          },
          path: {
            type: 'string',
            description: 'Alias for audio when passing a local audio path.',
          },
          language: {
            type: 'string',
            description:
              'Optional ISO language hint. Omit for provider language detection.',
          },
          prompt: {
            type: 'string',
            description:
              'Optional transcription prompt/context for names, terms, or style.',
          },
          timestamps: {
            type: 'string',
            enum: ['segment', 'word', 'none'],
            description:
              'Timestamp granularity. Segment is the default; word requests word-level timestamps when the provider supports them.',
          },
          diarization: {
            type: 'boolean',
            description:
              'Request speaker labels when supported by the selected provider.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'video_generate',
      description:
        'Generate deliverable videos with a configured video provider. Supports OpenAI Sora and Google Veo. Use action="list" to inspect provider readiness.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list'],
            description:
              'Use "list" to show configured video generation providers instead of generating.',
          },
          prompt: {
            type: 'string',
            description: 'Video generation prompt.',
          },
          aspectRatio: {
            type: 'string',
            description:
              'Optional aspect ratio such as 16:9, 9:16, landscape, or portrait.',
          },
          resolution: {
            type: 'string',
            description:
              'Optional provider resolution or size, such as 720x1280, 1280x720, 720p, 1080p, or 4k.',
          },
          size: {
            type: 'string',
            description: 'Alias for resolution.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional duration in seconds when supported.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
        },
        required: [],
      },
    },
  },
].map((entry) => entry.function);
