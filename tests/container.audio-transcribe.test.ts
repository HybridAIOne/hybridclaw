import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;

let workspaceRoot = '';

async function loadTools() {
  vi.resetModules();
  return import('../container/src/tools.js');
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-audio-transcribe-'),
  );
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('node:child_process');
  if (ORIGINAL_WORKSPACE_ROOT == null) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = ORIGINAL_WORKSPACE_ROOT;
  }
  if (ORIGINAL_WORKSPACE_DISPLAY_ROOT == null) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT =
      ORIGINAL_WORKSPACE_DISPLAY_ROOT;
  }
  vi.unstubAllGlobals();
  vi.resetModules();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('audio_transcribe tool', () => {
  test('lists provider readiness without requiring credentials', async () => {
    const { executeTool } = await loadTools();

    const output = await executeTool('audio_transcribe', '{"action":"list"}');
    const parsed = JSON.parse(output) as {
      success: boolean;
      configured_count: number;
      providers: Array<{ id: string; ready: boolean }>;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.configured_count).toBe(0);
    expect(parsed.providers).toEqual([
      expect.objectContaining({ id: 'openai', ready: false }),
      expect.objectContaining({ id: 'deepgram', ready: false }),
      expect.objectContaining({ id: 'assemblyai', ready: false }),
    ]);
  });

  test('preserves provider credentials when follow-up IPC input is redacted', async () => {
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({ openai: { apiKey: 'openai-test-key' } });
    setProviderCredentials(undefined);

    const output = await executeTool('audio_transcribe', '{"action":"list"}');
    const parsed = JSON.parse(output) as {
      configured_count: number;
      providers: Array<{ id: string; ready: boolean }>;
    };

    expect(parsed.configured_count).toBe(1);
    expect(parsed.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'openai', ready: true }),
      ]),
    );
  });

  test('returns a helpful error when transcription has no configured provider', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'audio_transcribe',
      JSON.stringify({ audio: '/workspace/clip.wav' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('audio_transcribe is not configured');
    expect(result.output).toContain('/secret set');
    expect(result.output).not.toContain('env');
  });

  test('transcribes local audio through OpenAI and persists transcript artifacts', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-1');
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.get('timestamp_granularities[]')).toBe('word');
      expect(form.get('language')).toBe('en');
      expect(form.get('file')).toBeTruthy();
      return new Response(
        JSON.stringify({
          text: 'Hello world.',
          language: 'en',
          duration: 12.5,
          segments: [{ start: 0, end: 12.5, text: 'Hello world.' }],
          words: [
            { start: 0, end: 0.5, word: 'Hello' },
            { start: 0.6, end: 1.0, word: 'world.' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({ openai: { apiKey: 'openai-test-key' } });

    const output = await executeTool(
      'audio_transcribe',
      JSON.stringify({
        audio: '/workspace/clip.wav',
        language: 'en',
        timestamps: 'word',
      }),
    );
    const parsed = JSON.parse(output) as {
      success: boolean;
      text: string;
      language: string;
      duration_sec: number;
      cost_usd: number;
      artifacts: Array<{ path: string; mimeType: string }>;
      words: Array<{ word: string }>;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe('Hello world.');
    expect(parsed.language).toBe('en');
    expect(parsed.duration_sec).toBe(12.5);
    expect(parsed.cost_usd).toBe(0.00125);
    expect(parsed.words.map((word) => word.word)).toEqual(['Hello', 'world.']);
    expect(parsed.artifacts).toEqual([
      expect.objectContaining({ mimeType: 'text/plain' }),
      expect.objectContaining({ mimeType: 'application/json' }),
    ]);
    for (const artifact of parsed.artifacts) {
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
        headers: expect.objectContaining({
          Authorization: 'Bearer openai-test-key',
        }),
      }),
    );
  });

  test('rejects remote audio redirects before following them', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('', {
        status: 302,
        headers: {
          location: 'http://127.0.0.1/internal.wav',
          'content-type': 'audio/wav',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setProviderCredentials } =
      await loadTools();
    setProviderCredentials({ openai: { apiKey: 'openai-test-key' } });

    const result = await executeToolWithMetadata(
      'audio_transcribe',
      JSON.stringify({
        audio: 'https://cdn.discordapp.com/attachments/1/2/clip.wav',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('audio URL redirects are not allowed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.discordapp.com/attachments/1/2/clip.wav',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  test('detect-language returns metadata only and skips transcript artifacts', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            text: 'Bonjour.',
            language: 'fr',
            duration: 2,
            segments: [{ start: 0, end: 2, text: 'Bonjour.' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({ openai: { apiKey: 'openai-test-key' } });

    const output = await executeTool(
      'audio_transcribe',
      JSON.stringify({
        action: 'detect-language',
        audio: '/workspace/clip.wav',
      }),
    );
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.action).toBe('detect-language');
    expect(parsed.language).toBe('fr');
    expect(parsed.duration_sec).toBe(2);
    expect(parsed).not.toHaveProperty('text');
    expect(parsed).not.toHaveProperty('segments');
    expect(parsed).not.toHaveProperty('words');
    expect(parsed).not.toHaveProperty('artifacts');
    expect(fs.existsSync(path.join(workspaceRoot, '.transcripts'))).toBe(false);
  });

  test('uses the only video/webm media item as implicit transcription input', async () => {
    const videoPath = path.join(workspaceRoot, 'clip.webm');
    fs.writeFileSync(videoPath, Buffer.from('fake-webm'));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('file')).toBeTruthy();
      return new Response(
        JSON.stringify({
          text: 'WebM transcript.',
          language: 'en',
          duration: 1,
          segments: [{ start: 0, end: 1, text: 'WebM transcript.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setMediaContext, setProviderCredentials } =
      await loadTools();
    setProviderCredentials({ openai: { apiKey: 'openai-test-key' } });
    setMediaContext([
      {
        path: '/workspace/clip.webm',
        url: '',
        originalUrl: '',
        filename: 'clip.webm',
        mimeType: 'video/webm',
        sizeBytes: 9,
      },
    ]);

    const output = await executeTool('audio_transcribe', '{}');
    const parsed = JSON.parse(output) as { text: string; source: string };

    expect(parsed.text).toBe('WebM transcript.');
    expect(parsed.source).toBe('/workspace/clip.webm');
  });

  test('transcribes through Deepgram with diarization and word timestamps', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('https://api.deepgram.com/v1/listen?');
      expect(url).toContain('diarize=true');
      expect(url).toContain('utterances=true');
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Token deepgram-test-key',
          'Content-Type': 'audio/wav',
        }),
      );
      return new Response(
        JSON.stringify({
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
              {
                start: 0,
                end: 1,
                transcript: 'Hello there.',
                speaker: 0,
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({ deepgram: { apiKey: 'deepgram-test-key' } });

    const output = await executeTool(
      'audio_transcribe',
      JSON.stringify({
        audio: '/workspace/clip.wav',
        provider: 'deepgram',
        diarization: true,
        timestamps: 'word',
      }),
    );
    const parsed = JSON.parse(output) as {
      provider: string;
      segments: Array<{ speaker?: string }>;
      words: Array<{ speaker?: string }>;
      language: string;
    };

    expect(parsed.provider).toBe('deepgram');
    expect(parsed.language).toBe('en');
    expect(parsed.segments[0]?.speaker).toBe('speaker_0');
    expect(parsed.words[0]?.speaker).toBe('speaker_0');
  });

  test('uses the configured speech-to-text default provider for auto transcription', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('https://api.deepgram.com/v1/listen?');
      return new Response(
        JSON.stringify({
          metadata: { duration: 2 },
          results: {
            channels: [
              {
                detected_language: 'en',
                alternatives: [{ transcript: 'Default provider.' }],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({
      speechToText: { defaultProvider: 'deepgram' },
      openai: { apiKey: 'openai-test-key' },
      deepgram: { apiKey: 'deepgram-test-key' },
    });

    const output = await executeTool(
      'audio_transcribe',
      JSON.stringify({ audio: '/workspace/clip.wav' }),
    );
    const parsed = JSON.parse(output) as { provider: string; text: string };

    expect(parsed.provider).toBe('deepgram');
    expect(parsed.text).toBe('Default provider.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('falls back to the next transcription provider only for quota or auth failures', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.openai.com/v1/audio/transcriptions') {
        return new Response(JSON.stringify({ error: 'quota exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(url).toContain('https://api.deepgram.com/v1/listen?');
      return new Response(
        JSON.stringify({
          metadata: { duration: 3 },
          results: {
            channels: [
              {
                detected_language: 'en',
                alternatives: [{ transcript: 'Fallback transcript.' }],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({
      openai: { apiKey: 'openai-test-key' },
      deepgram: { apiKey: 'deepgram-test-key' },
    });

    const output = await executeTool(
      'audio_transcribe',
      JSON.stringify({ audio: '/workspace/clip.wav' }),
    );
    const parsed = JSON.parse(output) as {
      provider: string;
      attempts: Array<{ provider: string; fallback_reason?: string }>;
    };

    expect(parsed.provider).toBe('deepgram');
    expect(parsed.attempts).toEqual([
      expect.objectContaining({
        provider: 'openai',
        fallback_reason: 'rate_limit',
      }),
      expect.objectContaining({ provider: 'deepgram' }),
    ]);
  });

  test('does not fall back to another transcription provider on non-fallback errors', async () => {
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      return new Response(JSON.stringify({ error: 'bad request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setProviderCredentials } =
      await loadTools();
    setProviderCredentials({
      openai: { apiKey: 'openai-test-key' },
      deepgram: { apiKey: 'deepgram-test-key' },
    });

    const result = await executeToolWithMetadata(
      'audio_transcribe',
      JSON.stringify({ audio: '/workspace/clip.wav' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Provider API error 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('transcribes local audio through AssemblyAI upload and polling', async () => {
    vi.useFakeTimers();
    const audioPath = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(audioPath, Buffer.from('fake-wav'));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v2/upload')) {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({ upload_url: 'https://cdn.test/audio' }),
        );
      }
      if (url.endsWith('/v2/transcript') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toEqual(
          expect.objectContaining({
            audio_url: 'https://cdn.test/audio',
            speaker_labels: true,
            language_detection: true,
            speakers_expected: 2,
          }),
        );
        return new Response(JSON.stringify({ id: 'transcript-1' }));
      }
      if (url.endsWith('/v2/transcript/transcript-1')) {
        return new Response(
          JSON.stringify({
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
          }),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({ assemblyai: { apiKey: 'assemblyai-test-key' } });

    const pending = executeTool(
      'audio_transcribe',
      JSON.stringify({
        audio: '/workspace/clip.wav',
        provider: 'assemblyai',
        diarization: true,
        min_speakers: 2,
        max_speakers: 2,
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1000);
    const output = await pending;
    const parsed = JSON.parse(output) as {
      provider: string;
      text: string;
      duration_sec: number;
      segments: Array<{ speaker?: string }>;
    };

    expect(parsed.provider).toBe('assemblyai');
    expect(parsed.text).toBe('Assembly transcript.');
    expect(parsed.duration_sec).toBe(3);
    expect(parsed.segments[0]?.speaker).toBe('speaker_A');
  });

  test('rejects conflicting speaker count hints', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'audio_transcribe',
      JSON.stringify({
        min_speakers: 2,
        max_speakers: 4,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('min_speakers and max_speakers must match');
  });

  test('chunks long remote audio after staging it to a temporary local file', async () => {
    const spawnSyncMock = vi.fn((command: string, args: string[]) => {
      if (command === 'ffprobe') {
        return { status: 0, stdout: '1600', stderr: '' };
      }
      if (command === 'ffmpeg') {
        const outputPath = args.at(-1);
        if (!outputPath) throw new Error('missing ffmpeg output path');
        fs.writeFileSync(outputPath, Buffer.from('fake-chunk'));
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${command}` };
    });
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      return { ...actual, spawnSync: spawnSyncMock };
    });

    let openAiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://cdn.discordapp.com/attachments/1/2/long.wav') {
        return new Response(Buffer.from('remote-wav'), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      openAiCalls += 1;
      const firstChunk = openAiCalls === 1;
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({ openai: { apiKey: 'openai-test-key' } });

    const output = await executeTool(
      'audio_transcribe',
      JSON.stringify({
        audio: 'https://cdn.discordapp.com/attachments/1/2/long.wav',
        provider: 'openai',
      }),
    );
    const parsed = JSON.parse(output) as { text: string; source: string };

    expect(parsed.text).toBe('First chunk. Second chunk.');
    expect(parsed.source).toBe(
      'https://cdn.discordapp.com/attachments/1/2/long.wav',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
        expect.stringContaining('.wav'),
      ]),
      expect.any(Object),
    );
  });

  test('stitches overlapped chunk segments without duplicate boundary text', async () => {
    const { stitchTranscriptionChunks } = await import(
      '../container/src/audio-transcribe.js'
    );

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
    expect(stitched.segments.map((segment) => segment.text)).toEqual([
      'First part.',
      'Boundary.',
      'Next part.',
    ]);
  });
});
