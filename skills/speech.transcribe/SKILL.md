---
name: speech.transcribe
description: Transcribe audio with the native audio_transcribe tool, including provider override, diarization, timestamps, language detection, and transcript artifacts.
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
    scope: OpenAI Whisper speech-to-text transcription.
    how_to_obtain: Create an OpenAI API key, then store it with `hybridclaw secret set OPENAI_API_KEY "<api-key>"`.
  - id: deepgram-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: DEEPGRAM_API_KEY
    scope: Deepgram speech-to-text transcription, diarization, and word timestamps.
    how_to_obtain: Create a Deepgram API key, then store it with `hybridclaw secret set DEEPGRAM_API_KEY "<api-key>"`.
  - id: assemblyai-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: ASSEMBLYAI_API_KEY
    scope: AssemblyAI async speech-to-text transcription, diarization, and word timestamps.
    how_to_obtain: Create an AssemblyAI API key, then store it with `hybridclaw secret set ASSEMBLYAI_API_KEY "<api-key>"`.
metadata:
  hybridclaw:
    category: media
    short_description: Provider-agnostic speech-to-text transcripts.
    tags:
      - speech
      - transcription
      - diarization
      - timestamps
      - audio
    related_roadmap:
      - R21.69
    issue: 999
    stakes_tiers:
      green:
        - provider-list
        - private-transcript
      amber:
        - provider-call
        - transcript-artifact
      red:
        - public-share
    escalation:
      writes: confirm-each
      route: f8
    cost_measurement:
      system: UsageTotals
      sub_limit_contract: R21.100
      sub_limit_key: speech-to-text
---

# Speech Transcribe

Use the native `audio_transcribe` tool when the user asks to transcribe,
caption, diarize, timestamp, or identify speakers in an audio or video clip.

## Workflow

1. Call `audio_transcribe` with `action: "list"` if you need provider
   readiness or the user asks what is configured.
2. Pass `audio` as a current attachment filename/ref, `/workspace` path,
   `/discord-media-cache` path, `/uploaded-media-cache` path, or HTTPS media
   URL.
3. Use `provider: "auto"` unless the user asks for `openai`, `deepgram`, or
   `assemblyai`, or unless diarization is required. Prefer Deepgram or
   AssemblyAI for speaker labels.
4. Pass `language` only when the user gives a known language. Omit it for
   provider language detection.
5. Set `diarization: true` when the user asks for speaker labels. Include
   `min_speakers` or `max_speakers` only when the user supplies a speaker
   count constraint.
6. Set `timestamps` to `word`, `segment`, or `none` based on the request.
7. Return the structured result fields that matter: transcript text, provider,
   detected language, duration, cost, warnings, and artifact paths.

The native tool owns provider credentials, provider fallback, output schema,
long-audio chunking for local OpenAI uploads when `ffmpeg`/`ffprobe` are
available, transcript artifact persistence, and usage-cost accounting.

## Output Contract

The tool returns JSON shaped like:

```json
{
  "text": "Transcript text",
  "segments": [{ "start": 0, "end": 1.2, "speaker": "speaker_0", "text": "..." }],
  "language": "en",
  "provider": "deepgram",
  "duration_sec": 12.3,
  "cost_usd": 0.001
}
```

Transcript text and segment JSON are also persisted as private workspace
artifacts. Treat transcripts as operator-private until the user explicitly asks
to share, post, email, or publish them.
