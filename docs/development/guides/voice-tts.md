---
title: Voice And TTS
description: Voice-reply setup, speech backend expectations, and the current audio delivery path for HybridClaw.
sidebar_position: 6
---

# Voice And TTS

HybridClaw has shared inbound audio transcription, but it does not currently
ship a first-party `tts.*` runtime config or a built-in speech-synthesis
provider.

If you are looking for the Twilio phone channel, inbound and outbound call
setup, or ConversationRelay webhooks, see
[Twilio Voice](./twilio-voice.md).

To make voice replies work today, use the supported delivery path that already
exists:

1. generate an audio file locally
2. keep that file in the active workspace or another sendable local path
3. send it back through the channel media path

## What Works Today

- **Inbound audio**: the gateway can transcribe attached `audio/*` media before
  the agent runs via `media.audio`.
- **Outbound audio**: HybridClaw can send generated audio files back to
  supported channels:
  - Discord sends local file attachments.
  - WhatsApp sends `audio/*` files as regular audio media.

Current limitation:

- WhatsApp outbound audio is sent as normal audio media, not as native PTT
  voice-note packets.

## Recommended Setup

If your TTS backend is installed on the host machine, run the gateway in host
mode so the agent can access it directly:

```bash
hybridclaw gateway start --foreground --sandbox=host
```

Typical host-side backends:

- local CLIs such as `say`, `ffmpeg`, Piper, or another speech binary
- an MCP server that wraps a TTS provider
- a custom skill/script that calls a provider API and writes the result to disk

If you stay in `container` mode, the same binary or MCP dependency must exist
inside the container image. Host-only installs are not visible there.

## Local Whisper Requirement

For inbound audio transcription with `whisper-cli`, the binary alone is not
enough. HybridClaw also needs a whisper.cpp model file.

The resolver checks:

- `WHISPER_CPP_MODEL`
- common Homebrew and `/usr/local` model locations such as
  `.../ggml-tiny.bin`, `.../ggml-base.bin`, and `.../ggml-small.bin`

If `whisper-cli` exists but no model file is found, auto-detect treats the
backend as unavailable and the turn will continue without a pre-agent
transcript.

If no transcription backend is available, HybridClaw now has one more fallback
before the agent starts improvising with shell tools:

- for `vllm` sessions, the container attaches the original current-turn audio
  to the latest user message as native model input
- this only runs when no `[AudioTranscript]` block was prepended already
- the original audio file still stays in media context for downstream tools or
  channel delivery

Example:

```bash
export WHISPER_CPP_MODEL=/opt/homebrew/share/whisper-cpp/ggml-tiny.bin
hybridclaw gateway restart --foreground --sandbox=host
```

## Delivery Rules

Generated audio should be written to a local file that HybridClaw can send.

- For Discord, the clean path is to send a local file with the `message` tool
  using `action="send"` and `filePath`.
- For WhatsApp, generated artifacts are sent back through the WhatsApp media
  delivery path when the turn returns an audio artifact.
- Keep generated files inside the active workspace unless you have a deliberate
  mounted path. That keeps send permissions and path resolution simple.

Useful formats:

- Discord: `.mp3`, `.wav`, `.ogg`, `.m4a`
- WhatsApp: prefer `.ogg`, `.opus`, or `.mp3` with an `audio/*` mime type

## Practical Pattern

The simplest reliable pattern is:

1. synthesize speech to a file
2. convert it to a channel-friendly format if needed
3. send that file

Example on macOS with built-in `say` and `ffmpeg`:

```bash
say -v Samantha -o reply.aiff "Hello from HybridClaw"
ffmpeg -y -i reply.aiff -c:a libopus reply.ogg
```

After that, send `reply.ogg` from the workspace.

## Agent Guidance

If you want the agent to use a specific voice or speaking style, put those
preferences in the workspace `TOOLS.md`. That file is intended for local setup
details such as preferred TTS voices, device names, and environment-specific
tool notes.

## Important Distinction

Do not confuse these two paths:

- `media.audio` is **speech-to-text** for inbound attachments
- TTS is **text-to-speech** for outbound replies and currently depends on your
  own local tool, MCP server, or custom script
