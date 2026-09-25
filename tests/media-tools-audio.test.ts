import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  runAudioTranscribe,
  stitchTranscriptionChunks,
} from '../plugins/media-tools/src/audio-transcribe.js';
import {
  createMediaToolsContext,
  jsonResponse,
  type MediaToolsTestContext,
  remoteResult,
} from './helpers/media-tools-context.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

type SpawnResult = { status: number; stdout: string; stderr: string };

// ffprobe/ffmpeg are stubbed so no test depends on host binaries; by default
// the probe "fails", which makes the runner skip chunking with a warning.
const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock:
    vi.fn<
      (command: string, args: string[], options?: object) => SpawnResult
    >(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

const makeTempDir = useTempDir('hybridclaw-media-audio-');
useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

let workspaceRoot = '';

beforeEach(() => {
  workspaceRoot = makeTempDir();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({
    status: 1,
    stdout: '',
    stderr: 'not available in tests',
  });
  return () => vi.useRealTimers();
});

function contextWith(
  providerCredentials: MediaToolsTestContext['providerCredentials'],
  overrides: Partial<MediaToolsTestContext> = {},
): MediaToolsTestContext {
  return createMediaToolsContext(workspaceRoot, {
    providerCredentials,
    ...overrides,
  });
}

function writeWorkspaceAudio(filename = 'clip.wav', data = 'fake-wav'): void {
  fs.writeFileSync(path.join(workspaceRoot, filename), Buffer.from(data));
}

async function run(args: Record<string, unknown>, context: object) {
  return JSON.parse(await runAudioTranscribe(args, context));
}

function deepgramPayload(transcript: string, duration = 2) {
  return {
    metadata: { duration },
    results: {
      channels: [
        { detected_language: 'en', alternatives: [{ transcript }] },
      ],
    },
  };
}

describe('audio_transcribe runner', () => {
  test('lists provider readiness without requiring credentials', async () => {
    const parsed = await run({ action: 'list' }, contextWith({}));

    expect(parsed.success).toBe(true);
    expect(parsed.configured_count).toBe(0);
    expect(parsed.providers).toEqual([
      expect.objectContaining({ id: 'openai', ready: false }),
      expect.objectContaining({ id: 'deepgram', ready: false }),
      expect.objectContaining({ id: 'assemblyai', ready: false }),
    ]);
  });

  test('throws a not-configured error when no provider is available', async () => {
    writeWorkspaceAudio();

    await expect(
      runAudioTranscribe({ audio: '/workspace/clip.wav' }, contextWith({})),
    ).rejects.toThrow(/audio_transcribe is not configured.*\/secret set/);
  });

  test('transcribes local audio through OpenAI and persists transcript artifacts', async () => {
    writeWorkspaceAudio();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-1');
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.get('timestamp_granularities[]')).toBe('word');
      expect(form.get('language')).toBe('en');
      expect(form.get('file')).toBeTruthy();
      return jsonResponse({
        text: 'Hello world.',
        language: 'en',
        duration: 12.5,
        segments: [{ start: 0, end: 12.5, text: 'Hello world.' }],
        words: [
          { start: 0, end: 0.5, word: 'Hello' },
          { start: 0.6, end: 1.0, word: 'world.' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await run(
      { audio: '/workspace/clip.wav', language: 'en', timestamps: 'word' },
      contextWith({ openai: { apiKey: 'test-key' } }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe('Hello world.');
    expect(parsed.language).toBe('en');
    expect(parsed.duration_sec).toBe(12.5);
    // Cost is estimated by the gateway usage module, not the tool.
    expect(parsed.usage).toEqual({ audio_seconds: 12.5 });
    expect(parsed).not.toHaveProperty('cost_usd');
    expect(parsed.words.map((word: { word: string }) => word.word)).toEqual([
      'Hello',
      'world.',
    ]);
    expect(parsed.artifacts).toEqual([
      expect.objectContaining({ mimeType: 'text/plain' }),
      expect.objectContaining({ mimeType: 'application/json' }),
    ]);
    for (const artifact of parsed.artifacts as Array<{ path: string }>) {
      expect(artifact.path).toMatch(/^\/workspace\/\.transcripts\//);
      expect(
        fs.existsSync(
          path.join(workspaceRoot, artifact.path.replace('/workspace/', '')),
        ),
      ).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
  });

  test('detect-language returns metadata only and skips transcript artifacts', async () => {
    writeWorkspaceAudio();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          text: 'Bonjour.',
          language: 'fr',
          duration: 2,
          segments: [{ start: 0, end: 2, text: 'Bonjour.' }],
        }),
      ),
    );

    const parsed = await run(
      { action: 'detect-language', audio: '/workspace/clip.wav' },
      contextWith({ openai: { apiKey: 'test-key' } }),
    );

    expect(parsed.action).toBe('detect-language');
    expect(parsed.language).toBe('fr');
    expect(parsed.duration_sec).toBe(2);
    for (const key of ['text', 'segments', 'words', 'artifacts']) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(fs.existsSync(path.join(workspaceRoot, '.transcripts'))).toBe(false);
  });

  test('uses the only video/webm media item as implicit transcription input', async () => {
    writeWorkspaceAudio('clip.webm', 'fake-webm');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect((init?.body as FormData).get('file')).toBeTruthy();
        return jsonResponse({
          text: 'WebM transcript.',
          language: 'en',
          duration: 1,
          segments: [{ start: 0, end: 1, text: 'WebM transcript.' }],
        });
      }),
    );

    const parsed = await run(
      {},
      contextWith(
        { openai: { apiKey: 'test-key' } },
        {
          media: [
            {
              path: '/workspace/clip.webm',
              url: '',
              originalUrl: '',
              filename: 'clip.webm',
              mimeType: 'video/webm',
              sizeBytes: 9,
            },
          ],
        },
      ),
    );

    expect(parsed.text).toBe('WebM transcript.');
    expect(parsed.source).toBe('/workspace/clip.webm');
  });

  test('transcribes through Deepgram with diarization and word timestamps', async () => {
    writeWorkspaceAudio();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toContain('https://api.deepgram.com/v1/listen?');
        expect(url).toContain('diarize=true');
        expect(url).toContain('utterances=true');
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Authorization: 'Token test-key',
            'Content-Type': 'audio/wav',
          }),
        );
        return jsonResponse({
          metadata: { duration: 4 },
          results: {
            channels: [
              {
                detected_language: 'en',
                alternatives: [
                  {
                    transcript: 'Hello there.',
                    words: [
                      {
                        word: 'Hello',
                        punctuated_word: 'Hello',
                        start: 0,
                        end: 0.5,
                        speaker: 0,
                      },
                    ],
                  },
                ],
              },
            ],
            utterances: [
              { start: 0, end: 1, transcript: 'Hello there.', speaker: 0 },
            ],
          },
        });
      }),
    );

    const parsed = await run(
      {
        audio: '/workspace/clip.wav',
        provider: 'deepgram',
        diarization: true,
        timestamps: 'word',
      },
      contextWith({ deepgram: { apiKey: 'test-key' } }),
    );

    expect(parsed.provider).toBe('deepgram');
    expect(parsed.language).toBe('en');
    expect(parsed.segments[0].speaker).toBe('speaker_0');
    expect(parsed.words[0].speaker).toBe('speaker_0');
  });

  test('uses the configured speech-to-text default provider for auto transcription', async () => {
    writeWorkspaceAudio();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('https://api.deepgram.com/v1/listen?');
      return jsonResponse(deepgramPayload('Default provider.'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await run(
      { audio: '/workspace/clip.wav' },
      contextWith({
        speechToText: { defaultProvider: 'deepgram' },
        openai: { apiKey: 'test-key' },
        deepgram: { apiKey: 'test-key' },
      }),
    );

    expect(parsed.provider).toBe('deepgram');
    expect(parsed.text).toBe('Default provider.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    [429, { error: 'quota exceeded' }, 'rate_limit'],
    [401, { error: 'invalid api key' }, 'auth'],
  ])('falls back to the next provider on OpenAI %i', async (status, body, reason) => {
    writeWorkspaceAudio();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'https://api.openai.com/v1/audio/transcriptions') {
          return jsonResponse(body, status);
        }
        expect(url).toContain('https://api.deepgram.com/v1/listen?');
        return jsonResponse(deepgramPayload('Fallback transcript.', 3));
      }),
    );

    const parsed = await run(
      { audio: '/workspace/clip.wav' },
      contextWith({
        openai: { apiKey: 'test-key' },
        deepgram: { apiKey: 'test-key' },
      }),
    );

    expect(parsed.provider).toBe('deepgram');
    expect(parsed.text).toBe('Fallback transcript.');
    expect(parsed.attempts).toEqual([
      expect.objectContaining({
        provider: 'openai',
        success: false,
        fallback_reason: reason,
      }),
      expect.objectContaining({ provider: 'deepgram', success: true }),
    ]);
  });

  test('does not fall back to another provider on non-fallback errors', async () => {
    writeWorkspaceAudio();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      return jsonResponse({ error: 'bad request' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runAudioTranscribe(
        { audio: '/workspace/clip.wav' },
        contextWith({
          openai: { apiKey: 'test-key' },
          deepgram: { apiKey: 'test-key' },
        }),
      ),
    ).rejects.toThrow('Provider API error 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('transcribes local audio through AssemblyAI upload and polling', async () => {
    vi.useFakeTimers();
    writeWorkspaceAudio();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v2/upload')) {
        expect(init?.method).toBe('POST');
        return jsonResponse({ upload_url: 'https://example.com/audio' });
      }
      if (url.endsWith('/v2/transcript') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual(
          expect.objectContaining({
            audio_url: 'https://example.com/audio',
            speaker_labels: true,
            language_detection: true,
            speakers_expected: 2,
          }),
        );
        return jsonResponse({ id: 'transcript-1' });
      }
      if (url.endsWith('/v2/transcript/transcript-1')) {
        return jsonResponse({
          status: 'completed',
          text: 'Assembly transcript.',
          language_code: 'en',
          audio_duration: 3,
          utterances: [
            {
              start: 0,
              end: 1200,
              text: 'Assembly transcript.',
              speaker: 'A',
            },
          ],
          words: [{ start: 0, end: 500, text: 'Assembly', speaker: 'A' }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = runAudioTranscribe(
      {
        audio: '/workspace/clip.wav',
        provider: 'assemblyai',
        diarization: true,
        min_speakers: 2,
        max_speakers: 2,
      },
      contextWith({ assemblyai: { apiKey: 'test-key' } }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1000);
    const parsed = JSON.parse(await pending);

    expect(parsed.provider).toBe('assemblyai');
    expect(parsed.text).toBe('Assembly transcript.');
    expect(parsed.duration_sec).toBe(3);
    expect(parsed.segments[0].speaker).toBe('speaker_A');
  });

  test('rejects conflicting speaker count hints', async () => {
    await expect(
      runAudioTranscribe({ min_speakers: 2, max_speakers: 4 }, contextWith({})),
    ).rejects.toThrow('min_speakers and max_speakers must match');
  });

  test('chunks long remote audio after staging it to a temporary local file', async () => {
    const remoteUrl = 'https://cdn.discordapp.com/attachments/1/2/long.wav';
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'ffprobe') return { status: 0, stdout: '1600', stderr: '' };
      if (command === 'ffmpeg') {
        const outputPath = args.at(-1);
        if (!outputPath) throw new Error('missing ffmpeg output path');
        fs.writeFileSync(outputPath, Buffer.from('fake-chunk'));
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${command}` };
    });
    let openAiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      openAiCalls += 1;
      const firstChunk = openAiCalls === 1;
      return jsonResponse({
        text: firstChunk ? 'First chunk.' : 'Second chunk.',
        language: 'en',
        duration: firstChunk ? 1500 : 110,
        segments: [
          {
            start: firstChunk ? 0 : 20,
            end: firstChunk ? 1 : 21,
            text: firstChunk ? 'First chunk.' : 'Second chunk.',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const context = contextWith({ openai: { apiKey: 'test-key' } });
    context.fetchRemote.mockResolvedValueOnce(
      remoteResult(Buffer.from('remote-wav'), 'audio/wav', remoteUrl),
    );

    const parsed = await run({ audio: remoteUrl, provider: 'openai' }, context);

    expect(parsed.text).toBe('First chunk. Second chunk.');
    expect(parsed.source).toBe(remoteUrl);
    expect(context.fetchRemote).toHaveBeenCalledWith(
      remoteUrl,
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining([
        '-show_entries',
        'format=duration',
        expect.stringContaining('long.wav'),
      ]),
      expect.any(Object),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-ss',
        '0',
        '-t',
        '1500',
        expect.stringContaining('long.wav'),
      ]),
      expect.any(Object),
    );
  });

  test('stitches overlapped chunk segments without duplicate boundary text', () => {
    const stitched = stitchTranscriptionChunks(
      [
        {
          offsetSec: 0,
          text: 'First part. Boundary.',
          language: 'en',
          durationSec: 1500,
          segments: [
            { start: 0, end: 1490, text: 'First part.' },
            { start: 1490, end: 1500, text: 'Boundary.' },
          ],
        },
        {
          offsetSec: 1490,
          text: 'Boundary. Next part.',
          language: 'en',
          durationSec: 20,
          segments: [
            { start: 0, end: 10, text: 'Boundary.' },
            { start: 10, end: 20, text: 'Next part.' },
          ],
        },
      ],
      10,
    );

    expect(stitched.text).toBe('First part. Boundary. Next part.');
    expect(stitched.segments.map((s: { text: string }) => s.text)).toEqual([
      'First part.',
      'Boundary.',
      'Next part.',
    ]);
  });
});
