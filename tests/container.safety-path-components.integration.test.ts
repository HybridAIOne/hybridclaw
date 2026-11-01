import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test('the real worker can run an interpreter inside an eval directory with all safety rules enabled', async () => {
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'check-version',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: './envs/eval/bin/node --version',
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'Version checked.' },
    ],
    { approvalMode: 'full' },
    {},
    {
      prepare: async (dir) => {
        const bin = path.join(dir, 'envs/eval/bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.symlinkSync(process.execPath, path.join(bin, 'node'));
        return {};
      },
    },
  );
  expect(worker.output.status).toBe('success');
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions).toHaveLength(1);
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'bash',
    isError: false,
  });
  expect(worker.output.toolExecutions?.[0].result).toMatch(/v\d+\.\d+\.\d+/);
});

test('an escaped eval is denied by the real worker before it can write a file', async () => {
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'escaped-eval',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: 'ev\\al "printf marker > accidental.txt"',
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'The command was blocked.' },
    ],
    { approvalMode: 'full' },
  );
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'bash',
    blocked: true,
    isError: true,
    approvalDecision: 'denied',
  });
  expect(fs.existsSync(path.join(worker.dir, 'accidental.txt'))).toBe(false);
});
