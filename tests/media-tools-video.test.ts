import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { runVideoGenerate } from '../plugins/media-tools/src/video-generation.js';
import {
  createMediaToolsContext,
  jsonResponse,
  type MediaToolsTestContext,
} from './helpers/media-tools-context.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-media-video-');
useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

let workspaceRoot = '';

beforeEach(() => {
  workspaceRoot = makeTempDir();
  return () => vi.useRealTimers();
});

function sessionContext(
  provider: string,
  model: string,
  baseUrl: string,
): MediaToolsTestContext {
  return createMediaToolsContext(workspaceRoot, {
    provider,
    model,
    baseUrl,
    apiKey: 'test-key',
  });
}

function videoResponse(bytes: Buffer): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });
}

async function run(args: Record<string, unknown>, context: object) {
  return JSON.parse(await runVideoGenerate(args, context));
}

function readGenerated(filename: string): Buffer {
  return fs.readFileSync(
    path.join(workspaceRoot, '.generated-videos', filename),
  );
}

describe('video_generate runner', () => {
  test('lists provider readiness without requiring credentials', async () => {
    const parsed = await run(
      { action: 'list' },
      createMediaToolsContext(workspaceRoot),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.configured_count).toBe(0);
    expect(parsed.providers).toEqual([
      expect.objectContaining({ id: 'openai', default_model: 'sora-2-pro' }),
      expect.objectContaining({
        id: 'gemini',
        default_model: 'veo-3.1-fast-generate-preview',
      }),
    ]);
  });

  test('persists OpenAI Sora video output', async () => {
    const videoBytes = Buffer.from('fake-mp4');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'video_123', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'video_123', status: 'completed' }),
      )
      .mockResolvedValueOnce(videoResponse(videoBytes));
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await run(
      { prompt: 'a short cinematic product shot' },
      sessionContext(
        'openai-codex',
        'openai-codex/sora-2',
        'https://api.openai.test/v1',
      ),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.videos[0].path).toMatch(
      /^\/workspace\/\.generated-videos\/video-/,
    );
    expect(parsed.artifacts).toEqual([
      expect.objectContaining({
        path: parsed.videos[0].path,
        filename: parsed.videos[0].filename,
        mimeType: 'video/mp4',
      }),
    ]);
    expect(readGenerated(parsed.videos[0].filename)).toEqual(videoBytes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.openai.test/v1/videos',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('persists Gemini Veo video output', async () => {
    const videoBytes = Buffer.from('veo-mp4');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'operations/video-op' }))
      .mockResolvedValueOnce(
        jsonResponse({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                {
                  video: {
                    uri: 'https://generativelanguage.googleapis.com/video.mp4',
                  },
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(videoResponse(videoBytes));
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await run(
      {
        prompt: 'a short cinematic product shot',
        aspectRatio: '9:16',
        resolution: '1080p',
      },
      sessionContext(
        'gemini',
        'gemini/veo-3.1-fast-generate-preview',
        'https://generativelanguage.googleapis.com/v1beta/openai',
      ),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.provider).toBe('gemini');
    expect(readGenerated(parsed.videos[0].filename)).toEqual(videoBytes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('waits up to ten minutes before timing out provider API calls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      ),
    );

    let settled = false;
    const resultPromise = runVideoGenerate(
      { prompt: 'a short cinematic product shot' },
      sessionContext(
        'openai-codex',
        'openai-codex/sora-2',
        'https://api.openai.test/v1',
      ),
    ).finally(() => {
      settled = true;
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      'provider API request timed out after 600000ms',
    );

    await vi.advanceTimersByTimeAsync(599_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});
