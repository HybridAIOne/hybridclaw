import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test('a Nebius worker executes native tool calls and sends the result to the same model', async () => {
  const result = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_sample',
            type: 'function',
            function: {
              name: 'read',
              arguments: '{"path":"sample.txt"}',
            },
          },
        ],
      },
      { role: 'assistant', content: 'The neutral sample is complete.' },
    ],
    {
      provider: 'nebius',
      model: 'nebius/zai-org/GLM-5.3-Flash',
      isLocal: false,
    },
    { 'sample.txt': 'NEUTRAL_SAMPLE_MARKER' },
  );
  expect(result.output.status).toBe('success');
  expect(result.output.toolsUsed).toContain('read');
  expect(result.output.toolExecutions?.[0]).toMatchObject({
    name: 'read',
    isError: false,
  });
  expect(result.output.toolExecutions?.[0].result).toContain(
    'NEUTRAL_SAMPLE_MARKER',
  );
  expect(result.requests).toHaveLength(2);
  expect(
    result.requests.every(
      (request) => request.model === 'zai-org/GLM-5.3-Flash',
    ),
  ).toBe(true);
  expect(result.requests[1].messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_sample' }),
    ]),
  );
});
