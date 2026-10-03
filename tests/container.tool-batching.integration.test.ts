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

// Tool starts and concurrent-batch markers from the runtime log, in order.
function toolTimeline(stderr: string): string[] {
  return stderr.split('\n').flatMap((line) => {
    const batch = /^\[tool\] running (\d+) tool calls concurrently/.exec(line);
    if (batch) return [`batch of ${batch[1]}`];
    const start = /^\[tool\] (\w+)(?: \[[^\]]*\])*: /.exec(line);
    return start ? [start[1]] : [];
  });
}

test('batches the calls around a bash barrier and runs a read after the write it depends on', async () => {
  const { output, stderr } = await runContainerAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('read-a', 'read', { path: 'a.txt' }),
          toolCall('read-b', 'read', { path: 'b.txt' }),
          toolCall('bash', 'bash', { command: 'echo between' }),
          toolCall('write-c', 'write', { path: 'c.txt', contents: 'fresh' }),
          toolCall('read-b-again', 'read', { path: 'b.txt' }),
          toolCall('read-c', 'read', { path: 'c.txt' }),
        ],
      },
    ],
    {},
    { 'a.txt': 'alpha', 'b.txt': 'beta', 'c.txt': 'stale' },
  );

  expect(output.status).toBe('success');
  expect(toolTimeline(stderr())).toEqual([
    'read',
    'read',
    'batch of 2',
    'bash',
    'write',
    'read',
    'batch of 2',
    'read',
  ]);
  expect(
    output.toolExecutions?.map((entry) => [entry.name, entry.result]),
  ).toEqual([
    ['read', 'alpha'],
    ['read', 'beta'],
    ['bash', expect.stringContaining('between')],
    ['write', expect.stringContaining('c.txt')],
    ['read', 'beta'],
    ['read', 'fresh'],
  ]);
});
