import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { runImageGenerate } from '../plugins/media-tools/src/image-generation.js';
import {
  createMediaToolsContext,
  jsonResponse,
  type MediaToolsTestContext,
  remoteResult,
} from './helpers/media-tools-context.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-media-image-');
useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

let workspaceRoot = '';

beforeEach(() => {
  workspaceRoot = makeTempDir();
  return () => vi.useRealTimers();
});

function openAiCodexContext(
  overrides: Partial<MediaToolsTestContext> = {},
): MediaToolsTestContext {
  return createMediaToolsContext(workspaceRoot, {
    provider: 'openai-codex',
    model: 'openai-codex/gpt-image-2',
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'test-key',
    ...overrides,
  });
}

async function run(args: Record<string, unknown>, context: object) {
  return JSON.parse(await runImageGenerate(args, context));
}

function readGenerated(filename: string): Buffer {
  return fs.readFileSync(
    path.join(workspaceRoot, '.generated-images', filename),
  );
}

describe('image_generate runner', () => {
  test.each([
    [{}, 0, []],
    [
      { openai: { apiKey: 'test-key' }, gemini: { apiKey: 'test-key' } },
      2,
      ['openai', 'gemini'],
    ],
  ])('lists provider readiness for credentials %j', async (providerCredentials, configuredCount, readyIds) => {
    const parsed = await run(
      { action: 'list' },
      createMediaToolsContext(workspaceRoot, { providerCredentials }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.configured_count).toBe(configuredCount);
    expect(parsed.providers.map((p: { id: string }) => p.id)).toEqual([
      'openai',
      'gemini',
      'xai',
      'bfl',
    ]);
    expect(
      parsed.providers
        .filter((p: { ready: boolean }) => p.ready)
        .map((p: { id: string }) => p.id),
    ).toEqual(readyIds);
  });

  test('throws a not-configured error when no provider is available', async () => {
    await expect(
      runImageGenerate(
        { prompt: 'a clean product icon' },
        createMediaToolsContext(workspaceRoot),
      ),
    ).rejects.toThrow(/image_generate is not configured.*\/secret set/);
  });

  test('persists generated image buffers and surfaces artifacts', async () => {
    const imageBytes = Buffer.from('fake-png');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              b64_json: imageBytes.toString('base64'),
              revised_prompt: 'A revised prompt',
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 1120,
            total_tokens: 1132,
            output_tokens_details: { image_tokens: 1120 },
          },
        }),
      ),
    );

    const parsed = await run(
      { prompt: 'a clean product icon', count: 1 },
      openAiCodexContext(),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.images[0].path).toMatch(
      /^\/workspace\/\.generated-images\/image-/,
    );
    expect(parsed.artifacts).toEqual([
      {
        path: parsed.images[0].path,
        filename: parsed.images[0].filename,
        mimeType: 'image/png',
      },
    ]);
    expect(parsed.usage).toEqual({
      input_tokens: 12,
      output_tokens: 1120,
      total_tokens: 1132,
      output_image_tokens: 1120,
      generated_images: 1,
    });
    expect(readGenerated(parsed.images[0].filename)).toEqual(imageBytes);
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
    const resultPromise = runImageGenerate(
      { prompt: 'a detailed product render' },
      openAiCodexContext(),
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

  test('falls back to another configured provider and reports attempts', async () => {
    const imageBytes = Buffer.from('xai-png');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { message: 'openai down' } }, 500),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ b64_json: imageBytes.toString('base64') }],
            usage: { cost_in_usd_ticks: 400000000 },
          }),
        ),
    );

    const parsed = await run(
      { prompt: 'a small app icon', quality: 'high' },
      openAiCodexContext({
        providerCredentials: { xai: { apiKey: 'test-key' } },
      }),
    );

    expect(parsed.provider).toBe('xai');
    expect(parsed.attempts).toEqual([
      expect.objectContaining({ provider: 'openai', success: false }),
      expect.objectContaining({ provider: 'xai', success: true }),
    ]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/xAI.*quality/);
    expect(parsed.usage.cost_usd).toBe(0.04);
    expect(readGenerated(parsed.images[0].filename)).toEqual(imageBytes);
  });

  test('warns when Gemini ignores unsupported options', async () => {
    const imageBytes = Buffer.from('gemini-png');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
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
      ),
    );

    const parsed = await run(
      {
        prompt: 'a watercolor landscape',
        size: '1024x1024',
        quality: 'high',
        count: 2,
      },
      createMediaToolsContext(workspaceRoot, {
        provider: 'gemini',
        model: 'gemini/gemini-3.1-flash-image-preview',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'test-key',
      }),
    );

    expect(parsed.provider).toBe('gemini');
    expect(parsed.warnings).toHaveLength(3);
    for (const option of ['size', 'quality', 'count']) {
      expect(
        parsed.warnings.some((warning: string) => warning.includes(option)),
      ).toBe(true);
    }
  });

  test('persists BFL FLUX.2 image output from async polling', async () => {
    const imageBytes = Buffer.from('flux-png');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'flux-request',
          polling_url: 'https://api.bfl.ai/v1/get_result?id=flux-request',
          cost: 3,
          input_mp: 0,
          output_mp: 1.2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'Ready',
          result: { sample: 'https://example.com/flux.png' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const context = createMediaToolsContext(workspaceRoot, {
      providerCredentials: { bfl: { apiKey: 'test-key' } },
    });
    context.fetchRemote.mockResolvedValueOnce(
      remoteResult(imageBytes, 'image/png'),
    );

    const parsed = await run({ prompt: 'a clean product icon' }, context);

    expect(parsed.provider).toBe('bfl');
    expect(parsed.model).toBe('flux-2-pro-preview');
    expect(parsed.usage).toEqual({
      generated_images: 1,
      cost_credits: 3,
      cost_usd: 0.03,
      input_megapixels: 0,
      output_megapixels: 1.2,
      estimated: false,
    });
    expect(readGenerated(parsed.images[0].filename)).toEqual(imageBytes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.bfl.ai/v1/flux-2-pro-preview',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(context.fetchRemote).toHaveBeenCalledWith(
      'https://example.com/flux.png',
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 }),
    );
  });

  test('routes remote reference images through fetchRemote restricted to Discord CDN', async () => {
    const context = openAiCodexContext();
    context.fetchRemote.mockRejectedValueOnce(new Error('blocked_url'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runImageGenerate(
        { prompt: 'edit this image', image: 'https://example.com/private.png' },
        context,
      ),
    ).rejects.toThrow('remote reference image download failed');
    expect(context.fetchRemote).toHaveBeenCalledWith(
      'https://example.com/private.png',
      expect.objectContaining({ discordCdnOnly: true }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['fetchRemote throws', 'rejects'],
    ['fetchRemote returns an oversized body', 'oversized'],
  ])('rejects provider image downloads when %s without persisting', async (_label, mode) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: [{ url: 'https://example.com/image.png' }] }),
      ),
    );
    const context = openAiCodexContext();
    if (mode === 'rejects') {
      context.fetchRemote.mockRejectedValueOnce(
        new Error('response exceeds max size'),
      );
    } else {
      context.fetchRemote.mockResolvedValueOnce(
        remoteResult(Buffer.alloc(20 * 1024 * 1024 + 1), 'image/png'),
      );
    }

    await expect(
      runImageGenerate({ prompt: 'a clean product icon' }, context),
    ).rejects.toThrow(/exceeds max size/);
    expect(fs.existsSync(path.join(workspaceRoot, '.generated-images'))).toBe(
      false,
    );
  });
});
