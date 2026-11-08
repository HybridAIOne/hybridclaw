import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('a worker applies both requested edits without editing its own inserted text', async () => {
  const run = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'edit-two',
            type: 'function',
            function: {
              name: 'edit',
              arguments: JSON.stringify({
                path: 'notes.txt',
                old: 'cat',
                new: 'cat dog',
                count: 2,
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'Updated both entries.' },
    ],
    {
      approvalMode: 'full',
      messages: [
        {
          role: 'user',
          content:
            'In notes.txt, replace the first two occurrences of cat with cat dog.',
        },
      ],
    },
    { 'notes.txt': 'cat cat cat' },
  );
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.toolExecutions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'edit', isError: false }),
    ]),
  );
  expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
    'cat dog cat dog cat',
  );
}, 20_000);

test('invalid counts report an error without changing the file, and a corrected edit can proceed', async () => {
  let step = 0;
  let workspace = '';
  const run = await runAgent(
    async () => {
      if (step === 1)
        expect(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8')).toBe(
          'cat cat',
        );
      if (step++ < 2)
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `edit-${step}`,
              type: 'function',
              function: {
                name: 'edit',
                arguments: JSON.stringify({
                  path: 'notes.txt',
                  old_text: 'cat',
                  new_text: 'dog',
                  count: step === 1 ? 1.5 : 1,
                }),
              },
            },
          ],
        };
      return { role: 'assistant', content: 'Updated the first entry.' };
    },
    { approvalMode: 'full' },
    { 'notes.txt': 'cat cat' },
    {
      prepare: async (dir) => {
        workspace = dir;
        return {};
      },
    },
  );
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(
    run.output.toolExecutions
      ?.filter((entry) => entry.name === 'edit')
      .map((entry) => entry.isError),
  ).toEqual([true, false]);
  expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
    'dog cat',
  );
}, 20_000);
