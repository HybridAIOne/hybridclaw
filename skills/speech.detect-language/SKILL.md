---
name: speech.detect-language
description: Detect the dominant spoken language in an audio clip with the native audio_transcribe tool.
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: openai-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: OPENAI_API_KEY
    scope: OpenAI speech-to-text language detection through transcription metadata.
    how_to_obtain: "Create an OpenAI API key. Set `OPENAI_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set OPENAI_API_KEY \"<api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set OPENAI_API_KEY \"<api-key>\"`."
  - id: deepgram-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: DEEPGRAM_API_KEY
    scope: Deepgram speech-to-text language detection.
    how_to_obtain: "Create a Deepgram API key. Set `DEEPGRAM_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set DEEPGRAM_API_KEY \"<api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set DEEPGRAM_API_KEY \"<api-key>\"`."
  - id: assemblyai-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: ASSEMBLYAI_API_KEY
    scope: AssemblyAI speech-to-text language detection.
    how_to_obtain: "Create an AssemblyAI API key. Set `ASSEMBLYAI_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set ASSEMBLYAI_API_KEY \"<api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set ASSEMBLYAI_API_KEY \"<api-key>\"`."
metadata:
  hybridclaw:
    category: media
    short_description: Spoken-language detection for audio routing.
    tags:
      - speech
      - transcription
      - language-detection
      - audio
    related_roadmap:
      - R21.69
    issue: 999
---

# Speech Detect Language

Use the native `audio_transcribe` tool with `action: "detect-language"` when
the user asks what language is spoken in an audio clip or when a later
transcription workflow needs a routing decision.

Pass `audio` as a current attachment filename/ref, `/workspace` path,
`/discord-media-cache` path, `/uploaded-media-cache` path, or HTTPS media URL.
Use `provider: "auto"` unless the user requests a specific provider.

Return the detected `language`, provider, duration, cost, and any warnings. Do
not present the full transcript unless the user asked for transcription.
