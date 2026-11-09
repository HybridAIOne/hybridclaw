import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir('vision-source-');
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
  'base64',
);
const fallback = 'https://cdn.discordapp.com/attachments/1/2/backup.png';
const completion = () =>
  Response.json({
    choices: [
      {
        message: { role: 'assistant', content: 'Image inspected.' },
        finish_reason: 'stop',
      },
    ],
  });

async function fixture(retryEnabled = false) {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_RETRY_ENABLED', String(retryEnabled));
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_ATTEMPTS', '2');
  vi.stubEnv('HYBRIDCLAW_RETRY_BASE_DELAY_MS', '100');
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_DELAY_MS', '100');
  const local = path.join(root, 'pixel.png');
  await fs.writeFile(local, image);
  const tools = await import('../container/src/tools.js');
  const { setModelContext, setTaskModelPolicies } = await import(
    '../container/src/model-context.js'
  );
  const policy = {
    provider: 'openrouter' as const,
    baseUrl: 'https://model.example.com/v1',
    apiKey: 'test-key',
    model: 'openrouter/example/image-model',
    chatbotId: '',
  };
  setModelContext(policy);
  setTaskModelPolicies({ vision: policy });
  tools.setMediaContext([], [], true, false);
  return {
    local,
    tools,
    analyze: (args: Record<string, unknown> = {}) =>
      tools.executeToolWithMetadata(
        'vision_analyze',
        JSON.stringify({
          image_url: local,
          fallback_url: fallback,
          question: 'Describe the image.',
          ...args,
        }),
      ),
  };
}

test.each([400, 401, 402, 403, 413, 429, 503])(
  'a provider %i does not download or analyze a different source',
  async (status) => {
    const { analyze } = await fixture();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: { message: 'Request rejected' } }, { status }),
      )
      .mockResolvedValueOnce(
        new Response(image, { headers: { 'content-type': 'image/png' } }),
      )
      .mockResolvedValueOnce(completion());
    vi.stubGlobal('fetch', fetch);
    const result = await analyze();
    expect(result.isError).toBe(true);
    expect(result.output).toContain(`Provider API error ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      'https://model.example.com/v1/chat/completions',
    );
  },
);

test('a readable local source takes precedence without downloading its fallback', async () => {
  const { analyze, local } = await fixture();
  const fetch = vi.fn(async () => completion());
  vi.stubGlobal('fetch', fetch);
  const result = await analyze();
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.output).source).toBe(local);
  expect(fetch).toHaveBeenCalledOnce();
});

test.each(['missing', 'empty', 'directory', 'oversized'])(
  'an unusable %s local source still uses its permitted fallback',
  async (kind) => {
    const { analyze, local } = await fixture();
    if (kind === 'missing') await fs.unlink(local);
    if (kind === 'empty') await fs.writeFile(local, '');
    if (kind === 'directory') {
      await fs.unlink(local);
      await fs.mkdir(local);
    }
    if (kind === 'oversized') await fs.truncate(local, 10 * 1024 * 1024 + 1);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(image, { headers: { 'content-type': 'image/png' } }),
      )
      .mockResolvedValueOnce(completion());
    vi.stubGlobal('fetch', fetch);
    const result = await analyze();
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).source).toBe(fallback);
    expect(fetch.mock.calls.map((args) => args[0])).toEqual([
      fallback,
      'https://model.example.com/v1/chat/completions',
    ]);
  },
);

test.each([true, false])(
  'transient provider retries preserve their image (recovery: %s)',
  async (recover) => {
    const { analyze } = await fixture(true);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: 'Temporary overload' } },
        { status: 503 },
      ),
    );
    if (recover)
      fetch
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: 'Temporary overload' } },
            { status: 503 },
          ),
        )
        .mockResolvedValueOnce(completion());
    vi.stubGlobal('fetch', fetch);
    const result = await analyze();
    expect(result.isError).toBe(!recover);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  },
);

test('failed source resolution reports both inputs without calling a model', async () => {
  const { analyze, local } = await fixture();
  await fs.unlink(local);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await analyze({
    fallback_url: 'https://example.com/blocked.png',
  });
  expect(result.isError).toBe(true);
  expect(result.output).toContain('local image not found');
  expect(result.output).toContain('remote image URL is blocked');
  expect(fetch).not.toHaveBeenCalled();
});

test('visual-data denial makes no provider or fallback requests', async () => {
  const { analyze, tools } = await fixture();
  tools.setMediaContext([], [], false, false);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect((await analyze()).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
