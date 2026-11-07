import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('a worker can insert literal dollar text into memory and subsequently remove or clear it', async () => {
  let workspace = '';
  let step = 0;
  const snapshots: Array<string | null> = [];
  const calls = [
    { action: 'append', content: 'Keep: alpha' },
    { action: 'replace', old_text: 'alpha', new_text: '$&' },
    { action: 'remove', old_text: '$&' },
    { action: 'write', content: '', confirm_overwrite: true },
  ];
  const run = await runAgent(
    async () => {
      const memory = path.join(workspace, 'memory');
      const file = fs.existsSync(memory)
        ? fs.readdirSync(memory).find((name) => name.endsWith('.md'))
        : undefined;
      snapshots.push(
        file ? fs.readFileSync(path.join(memory, file), 'utf8') : null,
      );
      if (step === calls.length) return { role: 'assistant', content: 'Done.' };
      const args = calls[step++];
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `memory-${step}`,
            type: 'function',
            function: { name: 'memory', arguments: JSON.stringify(args) },
          },
        ],
      };
    },
    { approvalMode: 'full' },
    { 'USER.md': '- **Timezone:** UTC\n' },
    {
      prepare: async (dir) => {
        workspace = dir;
        return {};
      },
    },
  );
  expect(snapshots).toEqual([
    null,
    'Keep: alpha\n',
    'Keep: $&\n',
    'Keep: \n',
    '',
  ]);
  expect(
    run.output.toolExecutions?.map((execution) => execution.isError),
  ).toEqual([false, false, false, false]);
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.result).toBe('Done.');
}, 20_000);
