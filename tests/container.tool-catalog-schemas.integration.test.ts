import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();

test.each([false, true])('executes dependent MCP reads without describe (list first: %s)', async (listFirst) => {
  let turn = 0;
  const { output, requests, dir } = await runContainerAgent(async (body) => {
    const stage = turn++ - Number(listFirst);
    if (stage === -1) return {
      role: 'assistant', content: null, tool_calls: [{
        id: 'discover', type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify({ action: 'list', query: 'lookup' }) },
      }],
    };
    if (stage === 0) {
      if (listFirst) {
        const result = JSON.parse(String(body.messages.at(-1)?.content));
        expect(result.tools.find((entry: { name: string }) => entry.name === 'records__lookup').parameters).toMatchObject({ type: 'object' });
      } else {
        const prompt = body.messages.filter((entry) => entry.role === 'system').map((entry) => entry.content).join('\n');
        const schema = prompt.split('\n').find((line) => line.startsWith('  parameters: '));
        expect(JSON.parse(schema!.slice('  parameters: '.length))).toMatchObject({ type: 'object' });
      }
    }
    if (stage === 2) return { role: 'assistant', content: 'Complete.' };
    const id = stage === 0 ? 'search-result' : `${body.messages.at(-1)?.content}-details`;
    return { role: 'assistant', content: null, tool_calls: [{
      id: `lookup-${stage}`, type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify({ action: 'call', name: 'records__lookup', arguments: { id } }) },
    }] };
  }, { isLocal: false, mcpToolMode: 'deferred' }, {}, {
    prepare: async (dir) => ({ mcpServers: { records: {
      transport: 'stdio', command: process.execPath,
      args: [path.resolve('tests/fixtures/concurrent-mcp-server.mjs'), path.join(dir, 'calls.jsonl')],
    } } }),
  });

  expect(output.status).toBe('success');
  expect(requests).toHaveLength(3 + Number(listFirst));
  expect(output.toolExecutions?.filter((entry) => entry.name === 'records__lookup').map((entry) => entry.result)).toEqual(['search-result', 'search-result-details']);
  const events = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events.map((entry) => entry.event)).toEqual(['start', 'end', 'start', 'end']);
  for (const request of requests) {
    expect(request.tools).toEqual(requests[0].tools);
    expect(request.tools.some((entry) => entry.function.name === 'records__lookup')).toBe(false);
    expect(request.messages.filter((entry) => entry.role === 'system')).toEqual(requests[0].messages.filter((entry) => entry.role === 'system'));
  }
});
