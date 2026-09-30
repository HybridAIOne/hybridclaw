import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { writeVisualPdfFixture } from './helpers/pdf-visual-fixture.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const tempDir = useTempDir();
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
async function setup() {
  const root = tempDir();
  await writeVisualPdfFixture(root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const tools = await import('../container/src/tools.js');
  tools.setMediaContext([], [], true);
  return { root, tools };
}
test('locates Figure 3 beyond the preview and delivers page 7; text cannot answer the pixel question', async () => {
  const { tools } = await setup();
  const search = await tools.executeToolWithMetadata(
    'read',
    JSON.stringify({ path: 'workshop.pdf', query: 'Figure 3' }),
  );
  expect(search.isError).toBe(false);
  expect(JSON.parse(search.output)).toMatchObject({
    pageCount: 7,
    searchedPages: 7,
    omittedPages: 0,
    matches: [{ page: 7 }],
  });
  const page = await tools.executeToolWithMetadata(
    'read',
    JSON.stringify({ path: 'workshop.pdf', pages: '7' }),
  );
  expect(page.visualAttachments?.[0].pages).toEqual([7]);
  expect(page.output).not.toMatch(/\b(red|blue|green|triangle|circle)\b/i);
});
test('image reads preserve pixels across worker replacement, without binary text', async () => {
  const { tools } = await setup();
  const result = await tools.executeToolWithMetadata(
    'read',
    JSON.stringify({ path: 'figure.png' }),
  );
  expect(result.isError).toBe(false);
  expect(result.visualAttachments?.[0].pages).toEqual([]);
  expect(result.output).not.toContain('IHDR');
  vi.resetModules();
  const { setVisualMediaAllowed } = await import(
    '../container/src/providers/visual-content.js'
  );
  setVisualMediaAllowed(true);
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const images = body.messages
        .flatMap((m: { content: unknown }) =>
          Array.isArray(m.content) ? m.content : [],
        )
        .filter((p: { type: string }) => p.type === 'image_url');
      expect(images).toHaveLength(1);
      expect(images[0].image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(JSON.stringify(body)).not.toContain('visualAttachments');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  await callRoutedModel({
    provider: 'vllm',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    chatbotId: '',
    model: 'qwen',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'read1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"figure.png"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'read1',
        content: result.output,
        visualAttachments: result.visualAttachments,
      },
    ],
  });
});
test('zero-image vLLM limit falls back without claiming inspection or retrying vision tools', async () => {
  const { tools } = await setup();
  const read = await tools.executeToolWithMetadata(
    'read',
    '{"path":"figure.png"}',
  );
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      requests.push(String(init.body));
      return requests.length === 1
        ? new Response(
            JSON.stringify({
              error: {
                message: 'At most 0 image(s) may be provided in one prompt.',
              },
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: 'assistant', content: 'Image unavailable' },
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
    }),
  );
  await callRoutedModel({
    provider: 'vllm',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    chatbotId: '',
    model: 'qwen',
    messages: [
      {
        role: 'user',
        content: read.output,
        visualAttachments: read.visualAttachments,
      },
    ],
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain('image_url');
  expect(requests[1]).not.toContain('image_url');
  expect(requests[1]).toContain('Visual content not sent');
});
test('image reads obey confidentiality, reject binary garbage and unsafe paths', async () => {
  const { root, tools } = await setup();
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  for (const args of [
    { path: 'data.bin' },
    { path: 'figure.png', offset: 1 },
    { path: '/tmp/unrelated.png' },
    { path: 'workshop.pdf', query: '' },
    { path: 'workshop.pdf', query: 'Figure', pages: '7' },
  ]) {
    expect(
      (await tools.executeToolWithMetadata('read', JSON.stringify(args)))
        .isError,
    ).toBe(true);
  }
  const read = await tools.executeToolWithMetadata(
    'read',
    '{"path":"figure.png"}',
  );
  tools.setMediaContext([], [], false);
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      expect(String(init.body)).not.toContain('image_url');
      expect(String(init.body)).toContain('Visual content not sent');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Unavailable' } }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  await callRoutedModel({
    provider: 'vllm',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    chatbotId: '',
    model: 'qwen',
    messages: [
      {
        role: 'user',
        content: read.output,
        visualAttachments: read.visualAttachments,
      },
    ],
  });
});
