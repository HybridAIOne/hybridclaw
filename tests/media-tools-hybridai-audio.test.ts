import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, expect, test, vi } from 'vitest';

import { runAudioTranscribe } from '../plugins/media-tools/src/audio-transcribe.js';
import {
  createMediaToolsContext,
  jsonResponse,
} from './helpers/media-tools-context.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'no probe' })),
}));

const makeTempDir = useTempDir('hybridclaw-hybridai-audio-');
useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });
let workspaceRoot = '';
beforeEach(() => {
  workspaceRoot = makeTempDir();
  fs.writeFileSync(path.join(workspaceRoot, 'clip.wav'), 'fake-wav');
});

function context() {
  return createMediaToolsContext(workspaceRoot, {
    provider: 'hybridai',
    model: 'chat-model',
    apiKey: 'test-hybridai-key',
    baseUrl: 'https://example.com',
    requestHeaders: {
      'X-Chat-Destination': 'chat-only',
      Authorization: 'wrong',
    },
  });
}

test.each([
  'https://example.com',
  'https://example.com/',
  'https://example.com/v1/',
])(
  'uses HybridAI session credentials at %s with the supported audio contract',
  async (baseUrl) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ text: 'See you then.' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ctx = { ...context(), baseUrl };
    const list = JSON.parse(await runAudioTranscribe({ action: 'list' }, ctx));
    expect(list.default_provider).toBe('hybridai');
    expect(list.configured_count).toBe(1);
    expect(list.providers[0]).toMatchObject({
      ready: true,
      active: true,
      capabilities: {
        language_detection: false,
        segment_timestamps: false,
        word_timestamps: false,
        diarization: false,
      },
    });
    const output = await runAudioTranscribe(
      {
        audio: '/workspace/clip.wav',
        language: 'en',
        prompt: 'Meeting notes',
        timestamps: 'word',
      },
      ctx,
    );
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      success: true,
      provider: 'hybridai',
      model: 'gpt-4o-mini-transcribe',
      text: 'See you then.',
      language: null,
      duration_sec: null,
      segments: [{ start: null, end: null, text: 'See you then.' }],
    });
    expect(parsed.warnings).toContain(
      'HybridAI returns transcript text without timestamps.',
    );
    expect(output).not.toContain(ctx.apiKey);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-hybridai-key' },
      }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('timestamp_granularities[]')).toBeNull();
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('Meeting notes');
    expect(form.get('file')).toBeInstanceOf(Blob);
    const transcript = parsed.artifacts.find(
      (entry: { mimeType: string }) => entry.mimeType === 'text/plain',
    );
    expect(
      fs.readFileSync(
        path.join(workspaceRoot, transcript.path.replace('/workspace/', '')),
        'utf8',
      ),
    ).toBe('See you then.');
  },
);

test('uses the configured HybridAI key and endpoint when chat uses a different provider', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse({ text: 'Friday.' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const ctx = {
    ...context(),
    provider: 'openai',
    baseUrl: 'https://chat.example.com/v1',
    apiKey: 'test-chat-key',
    providerCredentials: {
      hybridai: {
        apiKey: 'test-platform-key',
        baseUrl: 'https://platform.example.com',
      },
    },
  };
  const result = JSON.parse(
    await runAudioTranscribe({ audio: '/workspace/clip.wav' }, ctx),
  );
  expect(result.provider).toBe('hybridai');
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    'https://platform.example.com/v1/audio/transcriptions',
    expect.objectContaining({
      headers: { Authorization: 'Bearer test-platform-key' },
    }),
  );
});

test('does not substitute an unrelated chat credential when HybridAI is unconfigured', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    runAudioTranscribe(
      { audio: '/workspace/clip.wav' },
      { ...context(), provider: 'anthropic' },
    ),
  ).rejects.toThrow(/not configured/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('keeps an explicit provider override and configured preference', async () => {
  const ctx = context();
  ctx.providerCredentials = {
    openai: { apiKey: 'test-openai-key' },
    speechToText: { defaultProvider: 'openai' },
  };
  const list = JSON.parse(await runAudioTranscribe({ action: 'list' }, ctx));
  expect(list.default_provider).toBe('openai');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse({ text: 'Friday.' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const result = JSON.parse(
    await runAudioTranscribe(
      { audio: '/workspace/clip.wav', provider: 'hybridai' },
      ctx,
    ),
  );
  expect(result.provider).toBe('hybridai');
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://example.com/v1/audio/transcriptions',
  );
});

test('falls back on a HybridAI service failure using only the next provider credential', async () => {
  const ctx = context();
  ctx.providerCredentials = { openai: { apiKey: 'test-openai-key' } };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ error: 'Unavailable' }, 503))
    .mockResolvedValueOnce(jsonResponse({ text: 'Friday.' }));
  vi.stubGlobal('fetch', fetchMock);
  const result = JSON.parse(
    await runAudioTranscribe({ audio: '/workspace/clip.wav' }, ctx),
  );
  expect(result.provider).toBe('openai');
  expect(
    result.attempts.map((entry: { success: boolean }) => entry.success),
  ).toEqual([false, true]);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'https://api.openai.com/v1/audio/transcriptions',
    expect.objectContaining({
      headers: { Authorization: 'Bearer test-openai-key' },
    }),
  );
});

test('does not use another provider after an explicit HybridAI request fails', async () => {
  const ctx = context();
  ctx.providerCredentials = { openai: { apiKey: 'test-openai-key' } };
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse({ error: 'Unauthorized' }, 401),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    runAudioTranscribe(
      { audio: '/workspace/clip.wav', provider: 'hybridai' },
      ctx,
    ),
  ).rejects.toThrow(/all audio transcription providers failed/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('does not report successful language detection from a text-only backend', async () => {
  const ctx = context();
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse({ text: 'Hello.', language: 'en' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    runAudioTranscribe(
      { action: 'detect-language', audio: '/workspace/clip.wav' },
      ctx,
    ),
  ).rejects.toThrow(/language-detection metadata/);
  expect(fetchMock).not.toHaveBeenCalled();
  ctx.providerCredentials = { openai: { apiKey: 'test-openai-key' } };
  const result = JSON.parse(
    await runAudioTranscribe(
      { action: 'detect-language', audio: '/workspace/clip.wav' },
      ctx,
    ),
  );
  expect(result).toMatchObject({ provider: 'openai', language: 'en' });
});

test('keeps text-only transcripts when long audio is split without overlapping chunks', async () => {
  const starts: string[] = [];
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    if (command === 'ffprobe')
      return { status: 0, stdout: '1800', stderr: '' } as ReturnType<
        typeof spawnSync
      >;
    const argv = args as string[];
    starts.push(argv[argv.indexOf('-ss') + 1]);
    fs.writeFileSync(argv[argv.length - 1], 'fake-mp3');
    return { status: 0, stdout: '', stderr: '' } as ReturnType<
      typeof spawnSync
    >;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ text: 'First part.' }))
    .mockResolvedValueOnce(jsonResponse({ text: 'Second part.' }));
  vi.stubGlobal('fetch', fetchMock);
  const parsed = JSON.parse(
    await runAudioTranscribe({ audio: '/workspace/clip.wav' }, context()),
  );
  expect(parsed.text).toBe('First part. Second part.');
  expect(starts).toEqual(['0', '1500']);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(parsed.warnings).toContain(
    'audio was split into 2 chunks with 0s overlap.',
  );
});
