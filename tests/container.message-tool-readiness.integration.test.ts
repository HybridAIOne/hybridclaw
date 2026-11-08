import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const done = { role: 'assistant', content: 'Done.' };

test.each([
  { channels: undefined, offered: true },
  { channels: [], offered: false },
  { channels: ['heartbeat', 'scheduler'], offered: false },
  { channels: ['email'], offered: true },
  { channels: ['discord'], offered: true },
  { channels: ['tui'], offered: true },
])('advertises message from the readiness snapshot: %j', async ({ channels, offered }) => {
  const worker = await run([done], { localToolMode: 'full', activeMessageChannels: channels });
  const names = worker.requests[0].tools.map((tool) => tool.function.name);
  expect(names.includes('message')).toBe(offered);
  expect(names).toContain('http_request');
  expect(names).toContain('read');
});

test('does not execute a forced message call when the snapshot has no backend', async () => {
  const worker = await run([{
    role: 'assistant', content: null,
    tool_calls: [{ id: 'unavailable', type: 'function', function: {
      name: 'message', arguments: JSON.stringify({ action: 'read' }),
    } }],
  }], { localToolMode: 'full', activeMessageChannels: [] });
  expect(worker.output.status).toBe('error');
  expect(worker.output.toolExecutions).toEqual([]);
  expect(worker.requests).toHaveLength(1);
});

test('the catalog cannot recover an unavailable message backend', async () => {
  const worker = await run([{
    role: 'assistant', content: null,
    tool_calls: [{ id: 'unavailable', type: 'function', function: {
      name: 'tool_catalog', arguments: JSON.stringify({
        action: 'call', name: 'message', arguments: { action: 'read' },
      }),
    } }],
  }, done], { localToolMode: 'starred', localStarterTools: ['read'], activeMessageChannels: [] });
  expect(worker.output.toolExecutions).toEqual([
    expect.objectContaining({ name: 'tool_catalog', blocked: true, isError: true }),
  ]);
  expect(worker.requests).toHaveLength(2);
  expect(worker.requests.every((request) => !request.tools.some((tool) => tool.function.name === 'message'))).toBe(true);
});

test('refreshes channel readiness between requests and keeps each turn stable', async () => {
  const read = { role: 'assistant', content: null, tool_calls: [{
    id: 'notes', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'notes.txt' }) },
  }] };
  const worker = await run([read, done, read, done], {
    localToolMode: 'full', activeMessageChannels: [],
  }, { 'notes.txt': 'synthetic notes' });
  await worker.followup({ messages: [{ role: 'user', content: 'Read the notes again.' }], activeMessageChannels: ['email'] });
  expect(worker.requests).toHaveLength(4);
  expect(worker.requests[0].tools).toEqual(worker.requests[1].tools);
  expect(worker.requests[2].tools).toEqual(worker.requests[3].tools);
  expect(worker.requests[0].tools.some((tool) => tool.function.name === 'message')).toBe(false);
  expect(worker.requests[2].tools.some((tool) => tool.function.name === 'message')).toBe(true);
});
