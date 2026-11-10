import http from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

test('a replacement OpenAI worker replays native reasoning before tool history', async () => {
  const reasoning = {
    type: 'reasoning',
    id: 'reasoning_a',
    encrypted_content: null,
    summary: [],
    content: [{ type: 'reasoning_text', text: 'Synthetic provider state.' }],
  };
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      openai_response_items: [reasoning],
      tool_calls: [{
        id: 'previous_read',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"notes.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'previous_read', content: 'Previously read notes.' },
    { role: 'user', content: 'Use the previous result.' },
  ];
  const original = structuredClone(messages);
  const requests: Array<{ input: unknown[] }> = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'response_a',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }],
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const { output } = await run([], {
    provider: 'openai',
    model: 'openai/example-model',
    isLocal: false,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    messages,
  });
  expect(output.status).toBe('success');
  expect(output.result).toBe('Done.');
  expect(requests).toHaveLength(1);
  expect(requests[0].input.slice(0, 3)).toEqual([
    reasoning,
    { type: 'function_call', call_id: 'previous_read', name: 'read', arguments: '{"path":"notes.txt"}' },
    { type: 'function_call_output', call_id: 'previous_read', output: 'Previously read notes.' },
  ]);
  expect(messages).toEqual(original);
});
