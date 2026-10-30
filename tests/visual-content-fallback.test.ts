import { expect, test, vi } from 'vitest';
import { saveVisualSnapshot } from '../container/shared/visual-snapshots.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  resetModules: true,
});

async function fixture() {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  const ref = await saveVisualSnapshot(
    root,
    { pdf: '', images: ['aW1hZ2U='] },
    [1],
  );
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'read_a',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'read_a',
      content: 'Extracted page text',
      visualAttachments: [ref],
    },
  ];
  const { setVisualMediaAllowed } = await import(
    '../container/src/providers/visual-content.js'
  );
  setVisualMediaAllowed(true);
  return {
    provider: 'openrouter' as const,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    model: 'test-model',
    chatbotId: '',
    tools: [],
    messages,
    enableRag: false,
    requestHeaders: undefined,
    isLocal: false,
    contextWindow: undefined,
    thinkingFormat: undefined,
    maxTokens: 128,
  };
}

test.each([false, true])(
  'image-routing 404 retries with extracted text (stream=%s)',
  async (stream) => {
    const args = await fixture();
    const original = structuredClone(args.messages);
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        bodies.push(String(init.body));
        if (bodies.length === 1)
          return new Response(
            JSON.stringify({
              error: {
                message: 'No endpoints found that support image input',
                code: 404,
              },
            }),
            { status: 404 },
          );
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'Read successfully' },
                finish_reason: 'stop',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const { callRoutedModel, callRoutedModelStream } = await import(
      '../container/src/providers/router.js'
    );
    const onTextDelta = vi.fn();
    const response = stream
      ? await callRoutedModelStream({ ...args, onTextDelta })
      : await callRoutedModel(args);
    expect(response.choices[0].message.content).toBe('Read successfully');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('image_url');
    expect(bodies[1]).not.toContain('base64');
    const retry = JSON.parse(bodies[1]);
    expect(retry.model).toBe(args.model);
    expect(retry.messages.slice(0, 2)).toEqual([
      { role: 'assistant', content: null, tool_calls: original[0].tool_calls },
      { role: 'tool', tool_call_id: 'read_a', content: 'Extracted page text' },
    ]);
    expect(bodies[1]).toContain('Visual content not sent');
    expect(args.messages).toEqual(original);
    if (stream)
      expect(onTextDelta.mock.calls.flat()).toEqual(['Read successfully']);
  },
);

test.each([
  [404, 'Model not found'],
  [404, 'Invalid image URL: file not found'],
  [404, 'No endpoints found matching your data policy'],
  [401, 'No endpoints found that support image input'],
  [429, 'No endpoints found that support image input'],
  [500, 'No endpoints found that support image input'],
])('does not downgrade unrelated HTTP %s: %s', async (status, body) => {
  const args = await fixture();
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(callRoutedModel(args)).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('does not retry the image-routing rejection after streaming starts', async () => {
  const args = await fixture();
  const { callWithVisualContent } = await import(
    '../container/src/providers/visual-content.js'
  );
  const { ProviderRequestError } = await import(
    '../container/src/providers/shared.js'
  );
  const error = new ProviderRequestError(
    404,
    'No endpoints found that support image input',
  );
  const call = vi.fn(async () => {
    throw error;
  });
  await expect(callWithVisualContent(args, call, () => true)).rejects.toBe(
    error,
  );
  expect(call).toHaveBeenCalledTimes(1);
});

test('a rejected text fallback fails without looping', async () => {
  const args = await fixture();
  const { callWithVisualContent } = await import(
    '../container/src/providers/visual-content.js'
  );
  const { ProviderRequestError } = await import(
    '../container/src/providers/shared.js'
  );
  const error = new ProviderRequestError(
    404,
    'No endpoints found that support image input',
  );
  const call = vi.fn(async () => {
    throw error;
  });
  await expect(callWithVisualContent(args, call)).rejects.toBe(error);
  expect(call).toHaveBeenCalledTimes(2);
});

test('successful image delivery is unchanged', async () => {
  const args = await fixture();
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  const fetchMock = vi.fn(async (_url, init) => {
    expect(String(init.body)).toContain('image_url');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content: 'Visible' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  await callRoutedModel(args);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
