import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
test('the agent recovers a stale replacement with its returned revision and continues', async () => {
  let step = 0;
  let revision = '';
  const call = (name: string, args: Record<string, unknown>) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `step-${step}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const run = await runAgent(
    async (body) => {
      switch (step++) {
        case 0:
          return call('write', { path: 'note.txt', contents: 'Original\n' });
        case 1:
          return call('write', {
            path: 'note.txt',
            contents: 'Revised\n',
            overwrite: true,
            expected_content: 'wrong',
          });
        case 2:
          revision =
            String(body.messages.at(-1)?.content).match(/[a-f0-9]{64}/)?.[0] ||
            '';
          expect(revision).toHaveLength(64);
          return call('write', {
            path: 'note.txt',
            contents: 'Revised\n',
            overwrite: true,
            expected_sha256: revision,
          });
        case 3:
          return call('bash', { command: 'printf completed > done.txt' });
        default:
          return { role: 'assistant', content: 'Completed.' };
      }
    },
    { approvalMode: 'full' },
  );
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(fs.readFileSync(path.join(run.dir, 'note.txt'), 'utf8')).toBe(
    'Revised\n',
  );
  expect(fs.readFileSync(path.join(run.dir, 'done.txt'), 'utf8')).toBe(
    'completed',
  );
}, 20000);
