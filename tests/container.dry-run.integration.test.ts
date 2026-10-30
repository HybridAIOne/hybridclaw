import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

test('a dry run reads, refuses every change with a tool result, and still answers', async () => {
  const { output, requests, dir } = await runContainerAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('read-notes', 'read', { path: 'MEMORY.md' }),
          toolCall('write-notes', 'write', {
            path: 'MEMORY.md',
            contents: 'rewritten',
          }),
          toolCall('append-notes', 'bash', {
            command: 'echo learned >> MEMORY.md',
          }),
        ],
      },
      { role: 'assistant', content: 'The order ships on Friday.' },
    ],
    { dryRun: true, approvalMode: 'full' },
    { 'MEMORY.md': 'Orders ship on Fridays.\n' },
  );

  expect(output.status).toBe('success');
  expect(output.result).toBe('The order ships on Friday.');
  expect(output.pendingApproval).toBeUndefined();
  expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe(
    'Orders ship on Fridays.\n',
  );
  expect(
    output.toolExecutions?.map((entry) => [
      entry.name,
      entry.blocked === true,
      entry.approvalDecision,
    ]),
  ).toEqual([
    ['read', false, 'auto'],
    ['write', true, 'denied'],
    ['bash', true, 'denied'],
  ]);
  const toolResults = requests[1].messages.filter(
    (message) => message.role === 'tool',
  );
  expect(toolResults.map((message) => message.content)).toEqual([
    'Orders ship on Fridays.\n',
    expect.stringContaining('dry run'),
    expect.stringContaining('dry run'),
  ]);
});
