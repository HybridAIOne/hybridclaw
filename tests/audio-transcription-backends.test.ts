import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import {
  resolveAudioTranscriptionModels,
  transcribeAudioWithFallback,
} from '../src/media/audio-transcription-backends.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const DEFAULT_AUDIO_CONFIG = {
  enabled: true,
  maxBytes: 25 * 1024 * 1024,
  maxFiles: 4,
  maxCharsPerTranscript: 8_000,
  maxTotalChars: 16_000,
  timeoutMs: 30_000,
  prompt: '',
  language: '',
  models: [],
} as const;

const makeTempDir = useTempDir();

useCleanMocks({
  cleanup: () => {
    process.env.PATH = ORIGINAL_PATH;
    process.env.GOOGLE_API_KEY = ORIGINAL_GOOGLE_API_KEY;
  },
  restoreAllMocks: false,
  resetModules: true,
  unstubAllGlobals: true,
});

test('auto-detected audio backends do not require cache resets between PATH changes', async () => {
  const binDir = makeTempDir('hybridclaw-audio-bin-');
  process.env.PATH = binDir;

  const first = await resolveAudioTranscriptionModels(DEFAULT_AUDIO_CONFIG);
  expect(
    first.some((entry) => entry.type === 'cli' && entry.command === 'whisper'),
  ).toBe(false);

  const whisperPath = path.join(binDir, 'whisper');
  fs.writeFileSync(whisperPath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(whisperPath, 0o755);

  const second = await resolveAudioTranscriptionModels(DEFAULT_AUDIO_CONFIG);
  expect(
    second.some((entry) => entry.type === 'cli' && entry.command === 'whisper'),
  ).toBe(true);
});

test('google provider fallback uses the current default Gemini model', async () => {
  process.env.GOOGLE_API_KEY = 'test-google-key';

  const audioDir = makeTempDir('hybridclaw-audio-file-');
  const audioPath = path.join(audioDir, 'voice-note.ogg');
  fs.writeFileSync(audioPath, 'audio-bytes', 'utf8');

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain(
      '/models/gemini-3.1-flash-lite-preview:generateContent',
    );
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'transcribed from google' }],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  const transcript = await transcribeAudioWithFallback({
    filePath: audioPath,
    fileName: 'voice-note.ogg',
    mimeType: 'audio/ogg',
    config: DEFAULT_AUDIO_CONFIG,
    models: [{ type: 'provider', provider: 'google' }],
  });

  expect(transcript).toEqual({
    text: 'transcribed from google',
    backend: 'google/gemini-3.1-flash-lite-preview',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
