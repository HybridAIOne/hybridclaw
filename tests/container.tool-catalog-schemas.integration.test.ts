import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();

test('executes dependent small MCP reads directly without discovery', async () => {
  let turn = 0;
  const { output, requests, dir } = await runContainerAgent(async (body) => {
    const stage = turn++;
    expect(body.tools.find(entry => entry.function.name === 'records__lookup')?.function.parameters).toMatchObject({ type: 'object' });
    if (stage === 2) return { role: 'assistant', content: 'Complete.' };
    const id = stage === 0 ? 'search-result' : `${body.messages.at(-1)?.content}-details`;
    return { role: 'assistant', content: null, tool_calls: [{
      id: `lookup-${stage}`, type: 'function', function: { name: 'records__lookup', arguments: JSON.stringify({ id }) },
    }] };
  }, { isLocal: false, mcpToolMode: 'deferred' }, {}, {
    prepare: async (dir) => ({ mcpServers: { records: {
      toolBehavior: { trustAnnotations: true },
      transport: 'stdio', command: process.execPath,
      args: [path.resolve('tests/fixtures/concurrent-mcp-server.mjs'), path.join(dir, 'calls.jsonl')],
    } } }),
  });

  expect(output.status).toBe('success');
  expect(requests).toHaveLength(3);
  expect(output.toolExecutions?.filter((entry) => entry.name === 'records__lookup').map((entry) => entry.result)).toEqual(['search-result', 'search-result-details']);
  const events = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events.map((entry) => entry.event)).toEqual(['start', 'end', 'start', 'end']);
  for (const request of requests) {
    expect(request.tools).toEqual(requests[0].tools);
    expect(request.tools.some((entry) => entry.function.name === 'records__lookup')).toBe(true);
    expect(request.messages.filter((entry) => entry.role === 'system')).toEqual(requests[0].messages.filter((entry) => entry.role === 'system'));
  }
});
