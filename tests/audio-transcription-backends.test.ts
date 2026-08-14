import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import {
  resolveAudioTranscriptionModels,
  transcribeAudioWithFallback,
} from '../src/media/audio-transcription-backends.js';
import { logger } from '../src/logger.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
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


test('hybridai transcribes through the OpenAI-compatible surface at /v1', async () => {
  process.env.HYBRIDAI_API_KEY = 'test-hybridai-key';

  const audioDir = makeTempDir('hybridclaw-audio-hybridai-');
  const audioPath = path.join(audioDir, 'voice-note.ogg');
  fs.writeFileSync(audioPath, 'audio-bytes', 'utf8');

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://hybridai.one/v1/audio/transcriptions');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer test-hybridai-key',
    );
    return new Response(JSON.stringify({ text: 'transcribed by hybridai' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const transcript = await transcribeAudioWithFallback({
    filePath: audioPath,
    fileName: 'voice-note.ogg',
    mimeType: 'audio/ogg',
    config: DEFAULT_AUDIO_CONFIG,
    models: [{ type: 'provider', provider: 'hybridai' }],
  });

  expect(transcript).toEqual({
    text: 'transcribed by hybridai',
    backend: 'hybridai/gpt-4o-mini-transcribe',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('hybridai leads the auto-detected provider order', async () => {
  // HybridAI is the default provider, so a signed-in operator should get
  // dictation without configuring a second credential.
  const binDir = makeTempDir('hybridclaw-audio-order-');
  process.env.PATH = binDir;
  process.env.HYBRIDAI_API_KEY = 'test-hybridai-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const entries = await resolveAudioTranscriptionModels(DEFAULT_AUDIO_CONFIG);
  const providers = entries
    .filter((entry) => entry.type === 'provider')
    .map((entry) => entry.provider);

  expect(providers[0]).toBe('hybridai');
  expect(providers).toContain('openai');
});

test('does not warn when a later audio backend recovers the request', async () => {
  const audioDir = makeTempDir('hybridclaw-audio-fallback-');
  const audioPath = path.join(audioDir, 'voice-note.ogg');
  fs.writeFileSync(audioPath, 'audio-bytes', 'utf8');
  const warnSpy = vi
    .spyOn(logger, 'warn')
    .mockImplementation(() => undefined);

  try {
    const transcript = await transcribeAudioWithFallback({
      filePath: audioPath,
      fileName: 'voice-note.ogg',
      mimeType: 'audio/ogg',
      config: DEFAULT_AUDIO_CONFIG,
      models: [
        {
          type: 'cli',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
        },
        {
          type: 'cli',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("fallback transcript")'],
        },
      ],
    });

    expect(transcript).toEqual({
      text: 'fallback transcript',
      backend: `cli:${path.basename(process.execPath)}`,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
  }
});

test('warns once only after every audio backend fails', async () => {
  const audioDir = makeTempDir('hybridclaw-audio-failure-');
  const audioPath = path.join(audioDir, 'voice-note.ogg');
  fs.writeFileSync(audioPath, 'audio-bytes', 'utf8');
  const warnSpy = vi
    .spyOn(logger, 'warn')
    .mockImplementation(() => undefined);

  try {
    await expect(
      transcribeAudioWithFallback({
        filePath: audioPath,
        fileName: 'voice-note.ogg',
        mimeType: 'audio/ogg',
        config: DEFAULT_AUDIO_CONFIG,
        models: [
          {
            type: 'cli',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
          },
        ],
      }),
    ).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        failedBackends: [process.execPath],
        fileName: 'voice-note.ogg',
        filePath: audioPath,
      }),
      'All audio transcription backends failed',
    );
  } finally {
    warnSpy.mockRestore();
  }
});
