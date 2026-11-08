import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('a worker preserves memory after malformed writes and can still update and clear it explicitly', async () => {
  let workspace = '';
  let step = 0;
  const snapshots: string[] = [];
  const calls = [
    { action: 'append', content: 'Fixture note: alpha' },
    { action: 'write', confirm_overwrite: true },
    { action: 'replace', old_text: 'alpha' },
    { action: 'write', content: 'Fixture note: beta', confirm_overwrite: true },
    { action: 'replace', old_text: 'beta', new_text: '' },
  ];
  const run = await runAgent(
    async () => {
      const memory = path.join(workspace, 'memory');
      if (fs.existsSync(memory)) {
        const file = fs
          .readdirSync(memory)
          .find((name) => name.endsWith('.md'));
        if (file)
          snapshots.push(fs.readFileSync(path.join(memory, file), 'utf8'));
      }
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
  expect(snapshots).toHaveLength(5);
  expect(snapshots[0]).toContain('alpha');
  expect(snapshots.slice(0, 3)).toEqual(Array(3).fill(snapshots[0]));
  expect(snapshots[3]).toContain('beta');
  expect(snapshots[4]).not.toContain('beta');
  expect(
    run.output.toolExecutions?.map((execution) => execution.isError),
  ).toEqual([false, true, true, false, false]);
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.result).toBe('Done.');
}, 20_000);
