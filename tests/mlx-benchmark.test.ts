import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../src/inference/mlx-runtime.js', () => ({
  mlxCredentials: () => ({
    baseUrl: 'http://127.0.0.1:18323/v1',
    token: 'test-key',
    installation: {
      model: 'test-model',
      contextWindow: 4096,
      memoryLimitBytes: 4096,
    },
  }),
  mlxHealth: async () => ({ status: 'ready', peakMemoryBytes: 2048 }),
}));

import { benchmarkMlx } from '../src/inference/mlx-benchmark.js';

afterEach(() => vi.unstubAllGlobals());

function stream(visible: boolean, usage: boolean, done: boolean) {
  return new Response(
    [
      'data: ' +
        JSON.stringify({ choices: [{ delta: { reasoning: 'Counting.' } }] }),
      ...(visible
        ? [
            'data: ' +
              JSON.stringify({
                choices: [{ delta: { content: 'One, two.' } }],
              }),
          ]
        : []),
      ...(usage
        ? [
            'data: ' +
              JSON.stringify({
                usage: { prompt_tokens: 20, completion_tokens: 10 },
              }),
          ]
        : []),
      ...(done ? ['data: [DONE]'] : []),
      '',
    ].join('\n'),
  );
}

test.each([
  [false, true, true],
  [true, false, true],
  [true, true, false],
])('does not qualify reasoning-only, unmetered or incomplete streams (%s, %s, %s)', async (visible, usage, done) => {
  const fetch = vi.fn(async () => stream(visible, usage, done));
  vi.stubGlobal('fetch', fetch);
  await expect(benchmarkMlx('/example')).rejects.toThrow(
    'Incomplete local stream',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('qualifies a reasoning stream only after a real tool result returns', async () => {
  let calls = 0;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls++;
    if (calls === 1) {
      expect(body.max_tokens).toBe(512);
      return stream(true, true, true);
    }
    if (calls === 2)
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'local_probe',
                    arguments: '{"value":"hybridclaw"}',
                  },
                },
              ],
            },
          },
        ],
      });
    const result = body.messages.at(-1);
    expect(result.role).toBe('tool');
    expect(result.tool_call_id).toBe('call_1');
    expect(result.content).toMatch(/^verified-/);
    return Response.json({
      choices: [{ message: { role: 'assistant', content: result.content } }],
    });
  });
  vi.stubGlobal('fetch', fetch);
  const result = await benchmarkMlx('/example');
  expect(result.toolRoundTripPassed).toBe(true);
  expect(result.completionTokens).toBe(10);
  expect(fetch).toHaveBeenCalledTimes(3);
});
