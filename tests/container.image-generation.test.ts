import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;

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
  delete process.env.XAI_API_KEY;
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
  if (ORIGINAL_XAI_API_KEY == null) {
    delete process.env.XAI_API_KEY;
  } else {
    process.env.XAI_API_KEY = ORIGINAL_XAI_API_KEY;
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
      'openai-codex/gpt-image-1',
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

  test('falls back to another configured provider and reports attempts', async () => {
    process.env.XAI_API_KEY = 'xai-test-key';
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
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-1',
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
      'gemini/gemini-2.5-flash-image-preview',
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

  test('rejects unsafe remote reference image URLs', async () => {
    const { executeToolWithMetadata, setModelContext } = await loadTools();
    setModelContext(
      'openai-codex',
      undefined,
      'https://api.openai.test/v1',
      'test-key',
      'openai-codex/gpt-image-1',
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
});
