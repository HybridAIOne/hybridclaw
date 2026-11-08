import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('a real worker preserves a locked file and can recover with an authorized edit', async () => {
  const original = 'Status: draft\nReviewer: approved\n';
  let step = 0;
  let workspace = '';
  const run = await runAgent(
    async (body) => {
      if ((body.tools ?? []).length === 0) {
        return {
          role: 'assistant',
          content:
            '{"decision":"allow","reason":"Requested status update preserves the other content."}',
        };
      }
      if (step === 1) {
        expect(
          fs.readFileSync(path.join(workspace, 'report.txt'), 'utf8'),
        ).toBe(original);
        expect(fs.existsSync(path.join(workspace, 'report.txt.lock'))).toBe(
          true,
        );
        fs.rmdirSync(path.join(workspace, 'report.txt.lock'));
      }
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
                  path: 'report.txt',
                  old: 'Status: draft',
                  new: 'Status: final',
                }),
              },
            },
          ],
        };
      return {
        role: 'assistant',
        content: 'Updated the status and preserved the reviewer line.',
      };
    },
    {
      approvalMode: 'full',
      messages: [
        {
          role: 'user',
          content:
            'In report.txt, change Status: draft to Status: final. Preserve the other lines.',
        },
      ],
    },
    { 'report.txt': original },
    {
      prepare: async (dir) => {
        workspace = dir;
        fs.mkdirSync(path.join(dir, 'report.txt.lock'));
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
  expect(fs.readFileSync(path.join(run.dir, 'report.txt'), 'utf8')).toBe(
    'Status: final\nReviewer: approved\n',
  );
}, 20_000);
