import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test.each([
  { disabled: [], expected: ['eval', 'source-script'] },
  { disabled: ['eval'], expected: ['source-script'] },
  { disabled: ['source-script'], expected: ['eval'] },
])('the worker reports all blockers before any side effect ($disabled disabled)', async ({ disabled, expected }) => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [{
      id: 'compound-command', type: 'function', function: {
        name: 'bash',
        arguments: JSON.stringify({ command: 'eval "printf first > first.txt"; source ./setup.sh' }),
      },
    }] },
    { role: 'assistant', content: 'The requested command was blocked.' },
  ], { approvalMode: 'full', disabledSafetyRules: disabled }, {
    'setup.sh': 'printf second > second.txt\n',
  });

  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions).toHaveLength(1);
  const execution = worker.output.toolExecutions?.[0];
  expect(execution).toMatchObject({ blocked: true, isError: true, approvalDecision: 'denied' });
  const continuation = worker.requests[1].messages?.find((message) => message.role === 'tool');
  for (const result of [execution?.result, continuation?.content]) {
    expect(typeof result).toBe('string');
    expect([...String(result).matchAll(/Blocked by safety rule ([\w-]+):/g)]
      .map((match) => match[1])).toEqual(expected);
  }
  for (const file of ['first.txt', 'second.txt']) {
    expect(fs.existsSync(path.join(worker.dir, file))).toBe(false);
  }
});
