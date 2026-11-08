import { expect, test, vi } from 'vitest';
import { callHybridAIProviderStream } from '../container/src/providers/hybridai.js';
import { useCleanMocks } from './test-utils.js';
useCleanMocks({ unstubAllGlobals: true });
async function call(body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  );
  return callHybridAIProviderStream({
    provider: 'hybridai',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
    model: 'test-model',
    chatbotId: 'test-bot',
    enableRag: false,
    messages: [],
    tools: [],
    onTextDelta: () => {},
  });
}
const partial = 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n';
test('EOF without a completion marker rejects partial output', async () => {
  await expect(call(partial)).rejects.toThrow();
});
test.each([{ message: 'Test upstream error' }, 'Test upstream error', {}])(
  'a streamed provider error rejects partial output: %j',
  async (error) => {
    await expect(
      call(
        partial + `data: ${JSON.stringify({ error })}\n\n` + 'data: [DONE]\n\n',
      ),
    ).rejects.toThrow();
  },
);
test.each([
  'data: [DONE]\n\n',
  'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
])('accepts an explicit completion marker: %s', async (ending) => {
  const result = await call(partial + ending);
  expect(result.choices[0].message.content).toBe('Partial');
  expect(result.choices[0].finish_reason).toBe('stop');
});
