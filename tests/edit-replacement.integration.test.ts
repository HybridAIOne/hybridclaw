import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
test.each([{}, { new_text: null }])(
  'a worker rejects malformed replacement %j and can continue with valid edits and deletion',
  async (invalid) => {
    let step = 0;
    let workspace = '';
    const snapshots: string[] = [];
    const original = 'Keep: alpha\nRemove: sample\n';
    const run = await runAgent(
      async () => {
        snapshots.push(
          fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'),
        );
        const calls = [
          { path: 'notes.txt', old: 'alpha', ...invalid },
          { path: 'notes.txt', old: 'sample', new: 'done' },
          { path: 'notes.txt', old_text: 'done', new_text: '' },
        ];
        if (step < calls.length) {
          const args = calls[step++];
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `edit-${step}`,
                type: 'function',
                function: { name: 'edit', arguments: JSON.stringify(args) },
              },
            ],
          };
        }
        return { role: 'assistant', content: 'Finished the requested edits.' };
      },
      { approvalMode: 'full' },
      { 'notes.txt': original },
      {
        prepare: async (dir) => {
          workspace = dir;
          return {};
        },
      },
    );
    expect
      .soft(snapshots)
      .toEqual([
        original,
        original,
        'Keep: alpha\nRemove: done\n',
        'Keep: alpha\nRemove: \n',
      ]);
    expect(run.output.pendingApproval).toBeUndefined();
    expect
      .soft(
        run.output.toolExecutions
          ?.filter((entry) => entry.name === 'edit')
          .map((entry) => entry.isError),
      )
      .toEqual([true, false, false]);
    expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
      'Keep: alpha\nRemove: \n',
    );
  },
  20_000,
);
