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
    path.join(os.tmpdir(), 'hybridclaw-image-generate-'),
  );
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
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

describe('image_generate tool', () => {
  test('lists provider readiness without requiring credentials', async () => {
    const { executeTool } = await loadTools();

    const output = await executeTool('image_generate', '{"action":"list"}');
    const parsed = JSON.parse(output) as {
      success: boolean;
      configured_count: number;
      providers: Array<{ id: string; ready: boolean }>;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.configured_count).toBe(0);
    expect(parsed.providers.map((provider) => provider.id)).toEqual([
      'openai',
      'gemini',
      'xai',
      'bfl',
    ]);
  });

  test('returns a helpful error when generation has no configured provider', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({ prompt: 'a clean product icon' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('image_generate is not configured');
  });

  test('lists gateway-resolved provider credentials without env exposure', async () => {
    const { executeTool, setProviderCredentials } = await loadTools();
    setProviderCredentials({
      openai: { apiKey: 'openai-test-key' },
      gemini: { apiKey: 'gemini-test-key' },
    });

    const output = await executeTool('image_generate', '{"action":"list"}');
    const parsed = JSON.parse(output) as {
      configured_count: number;
      providers: Array<{ id: string; ready: boolean }>;
    };

    expect(parsed.configured_count).toBe(2);
    expect(parsed.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'openai', ready: true }),
        expect.objectContaining({ id: 'gemini', ready: true }),
      ]),
    );
  });

  test('persists generated image buffers and surfaces artifacts', async () => {
    const imageBytes = Buffer.from('fake-png');
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              b64_json: imageBytes.toString('base64'),
              revised_prompt: 'A revised prompt',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-2',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({ prompt: 'a clean product icon', count: 1 }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      images: Array<{ path: string; filename: string; mimeType: string }>;
      artifacts: Array<{ path: string; filename: string; mimeType: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.images[0]?.path).toMatch(
      /^\/workspace\/\.generated-images\/image-/,
    );
    expect(parsed.artifacts).toEqual([
      {
        path: parsed.images[0]?.path,
        filename: parsed.images[0]?.filename,
        mimeType: 'image/png',
      },
    ]);
    const hostPath = path.join(
      workspaceRoot,
      '.generated-images',
      parsed.images[0]?.filename || '',
    );
    expect(fs.readFileSync(hostPath)).toEqual(imageBytes);
  });

  test('waits up to ten minutes before timing out provider API calls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-2',
      '',
      {},
    );

    let settled = false;
    const resultPromise = executeToolWithMetadata(
      'image_generate',
      JSON.stringify({ prompt: 'a detailed product render' }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(599_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'provider API request timed out after 600000ms',
    );
  });

  test('falls back to another configured provider and reports attempts', async () => {
    const imageBytes = Buffer.from('xai-png');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'openai down' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ b64_json: imageBytes.toString('base64') }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext, setProviderCredentials } =
      await loadTools();
    setProviderCredentials({ xai: { apiKey: 'xai-test-key' } });
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-2',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({
        prompt: 'a small app icon',
        quality: 'high',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      provider: string;
      attempts: Array<{ provider: string; success: boolean }>;
      warnings: string[];
    };

    expect(result.isError).toBe(false);
    expect(parsed.provider).toBe('xai');
    expect(parsed.attempts).toEqual([
      expect.objectContaining({ provider: 'openai', success: false }),
      expect.objectContaining({ provider: 'xai', success: true }),
    ]);
    expect(parsed.warnings).toContain(
      'xAI does not support quality; quality was ignored.',
    );
  });

  test('warns when Gemini ignores unsupported options', async () => {
    const imageBytes = Buffer.from('gemini-png');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: imageBytes.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'gemini',
      undefined,
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'gemini-test-key',
      'gemini/gemini-3.1-flash-image-preview',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({
        prompt: 'a watercolor landscape',
        size: '1024x1024',
        quality: 'high',
        count: 2,
      }),
    );
    const parsed = JSON.parse(result.output) as { warnings: string[] };

    expect(result.isError).toBe(false);
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        'Gemini does not support size; size was ignored.',
        'Gemini does not support quality; quality was ignored.',
        'Gemini returns provider-defined image counts; count was not enforced.',
      ]),
    );
  });

  test('persists BFL FLUX.2 image output from async polling', async () => {
    const imageBytes = Buffer.from('flux-png');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'flux-request',
            polling_url: 'https://api.bfl.ai/v1/get_result?id=flux-request',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'Ready',
            result: { sample: 'https://93.184.216.34/flux.png' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(imageBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setProviderCredentials } =
      await loadTools();
    setProviderCredentials({ bfl: { apiKey: 'bfl-test-key' } });

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({ prompt: 'a clean product icon' }),
    );
    const parsed = JSON.parse(result.output) as {
      provider: string;
      model: string;
      images: Array<{ filename: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.provider).toBe('bfl');
    expect(parsed.model).toBe('flux-2-pro-preview');
    expect(
      fs.readFileSync(
        path.join(
          workspaceRoot,
          '.generated-images',
          parsed.images[0]?.filename || '',
        ),
      ),
    ).toEqual(imageBytes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.bfl.ai/v1/flux-2-pro-preview',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('rejects unsafe remote reference image URLs', async () => {
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-2',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({
        prompt: 'edit this image',
        image: 'https://example.com/private.png',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('remote reference image URL is blocked');
  });

  test('rejects provider image URLs that target private hosts', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ url: 'https://127.0.0.1/private.png' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-2',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({ prompt: 'a clean product icon' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'provider image URL blocked: private or loopback host',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects oversized provider image downloads before persisting', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ url: 'https://93.184.216.34/image.png' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(21 * 1024 * 1024),
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-2',
      '',
      {},
    );

    const result = await executeToolWithMetadata(
      'image_generate',
      JSON.stringify({ prompt: 'a clean product icon' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('generated image exceeds max size');
    expect(fs.existsSync(path.join(workspaceRoot, '.generated-images'))).toBe(
      false,
    );
  });
});
