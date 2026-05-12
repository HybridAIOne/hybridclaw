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
    path.join(os.tmpdir(), 'hybridclaw-video-generate-'),
  );
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  vi.unstubAllGlobals();
});

afterEach(() => {
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

describe('video_generate tool', () => {
  test('lists provider readiness without requiring credentials', async () => {
    const { executeTool } = await loadTools();

    const output = await executeTool('video_generate', '{"action":"list"}');
    const parsed = JSON.parse(output) as {
      success: boolean;
      configured_count: number;
      providers: Array<{ id: string; ready: boolean; default_model: string }>;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.configured_count).toBe(0);
    expect(parsed.providers).toEqual([
      expect.objectContaining({
        id: 'openai',
        default_model: 'sora-2-pro',
      }),
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'video_123', status: 'queued' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'video_123', status: 'completed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(videoBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/sora-2',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'video_generate',
      JSON.stringify({ prompt: 'a short cinematic product shot' }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      videos: Array<{ path: string; filename: string; mimeType: string }>;
      artifacts: Array<{ path: string; filename: string; mimeType: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.videos[0]?.path).toMatch(
      /^\/workspace\/\.generated-videos\/video-/,
    );
    expect(parsed.artifacts).toEqual([
      expect.objectContaining({
        path: parsed.videos[0]?.path,
        filename: parsed.videos[0]?.filename,
        mimeType: 'video/mp4',
      }),
    ]);
    const hostPath = path.join(
      workspaceRoot,
      '.generated-videos',
      parsed.videos[0]?.filename || '',
    );
    expect(fs.readFileSync(hostPath)).toEqual(videoBytes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.openai.test/v1/videos',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('persists Gemini Veo video output', async () => {
    const videoBytes = Buffer.from('veo-mp4');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'operations/video-op' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
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
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(videoBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'gemini',
      undefined,
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'gemini-test-key',
      'gemini/veo-3.1-fast-generate-preview',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'video_generate',
      JSON.stringify({
        prompt: 'a short cinematic product shot',
        aspectRatio: '9:16',
        resolution: '1080p',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      provider: string;
      videos: Array<{ filename: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.provider).toBe('gemini');
    expect(
      fs.readFileSync(
        path.join(
          workspaceRoot,
          '.generated-videos',
          parsed.videos[0]?.filename || '',
        ),
      ),
    ).toEqual(videoBytes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
