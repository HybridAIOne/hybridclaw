import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir('vision-mime-');
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const policy = {
  provider: 'openrouter' as const,
  baseUrl: 'https://model.example.com/v1',
  apiKey: 'test-key',
  model: 'openrouter/example/image-model',
  chatbotId: '',
};

test.each([
  ['misnamed.png', jpeg, 'image/png', 'image/jpeg'],
  ['misnamed.jpg', png, 'image/jpeg', 'image/png'],
  ['no-extension', jpeg, null, 'image/jpeg'],
  [
    'legacy.svg',
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    null,
    'image/svg+xml',
  ],
  ['legacy.bmp', Buffer.from('424d0000', 'hex'), null, 'image/bmp'],
  ['legacy.tiff', Buffer.from('49492a00', 'hex'), null, 'image/tiff'],
] as const)(
  'vision sends byte-derived MIME for %s',
  async (name, bytes, hint, expected) => {
    const root = tempDir();
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
    vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
    const image = path.join(root, name);
    await fs.writeFile(image, bytes);
    const tools = await import('../container/src/tools.js');
    const context = await import('../container/src/model-context.js');
    context.setModelContext(policy);
    context.setTaskModelPolicies({ vision: policy });
    tools.setMediaContext([{ path: image, mimeType: hint }], [], true, false);
    const fetch = vi.fn(
      async (_url: unknown, init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body));
        const url = body.messages[0].content.find(
          (part: { type: string }) => part.type === 'image_url',
        ).image_url.url;
        expect(url).toBe(`data:${expected};base64,${bytes.toString('base64')}`);
        return Response.json({
          choices: [
            {
              message: { role: 'assistant', content: 'Inspected.' },
              finish_reason: 'stop',
            },
          ],
        });
      },
    );
    vi.stubGlobal('fetch', fetch);
    const result = await tools.executeToolWithMetadata(
      'vision_analyze',
      JSON.stringify({ image_url: image, question: 'Describe this image.' }),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).mime_type).toBe(expected);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await fs.readFile(image)).toEqual(bytes);
  },
);

test('downloaded image bytes override an incorrect image Content-Type', async () => {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const tools = await import('../container/src/tools.js');
  const context = await import('../container/src/model-context.js');
  context.setModelContext(policy);
  context.setTaskModelPolicies({ vision: policy });
  tools.setMediaContext([], [], true, false);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(jpeg, { headers: { 'Content-Type': 'image/png' } }),
    )
    .mockImplementationOnce(
      async (_url: unknown, init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content[1].image_url.url).toBe(
          `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        );
        return Response.json({
          choices: [
            {
              message: { role: 'assistant', content: 'Inspected.' },
              finish_reason: 'stop',
            },
          ],
        });
      },
    );
  vi.stubGlobal('fetch', fetch);
  const result = await tools.executeToolWithMetadata(
    'vision_analyze',
    JSON.stringify({
      image_url: 'https://cdn.discordapp.com/attachments/1/2/image.png',
      question: 'Describe this image.',
    }),
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.output).mime_type).toBe('image/jpeg');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('native image delivery also follows bytes rather than attachment metadata', async () => {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const image = path.join(root, 'misnamed.png');
  await fs.writeFile(image, jpeg);
  const { injectNativeVisionContent } = await import(
    '../container/src/native-media.js'
  );
  const messages = await injectNativeVisionContent({
    messages: [{ role: 'user', content: 'Describe the attachment.' }],
    model: 'openrouter/openai/gpt-4o',
    media: [{ path: image, mimeType: 'image/png' }],
  });
  const content = messages[0].content;
  expect(content).toEqual(
    expect.arrayContaining([
      {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
      },
    ]),
  );
});
