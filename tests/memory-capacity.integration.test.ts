import fs from 'node:fs';
import path from 'node:path';
import { DAILY_MEMORY_MAX_CHARS } from '@hybridclaw/shared/daily-memory';
import { currentDateStampInTimezone } from '@hybridclaw/shared/workspace-time';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('a worker receives capacity errors, blocks unchanged retries and recovers with a targeted replacement', async () => {
  const verbose = 'Repeated detail. '.repeat(50);
  const unique = '\n- Preserve this unique decision.\n';
  const original = `${'x'.repeat(DAILY_MEMORY_MAX_CHARS - verbose.length - unique.length)}${verbose}${unique}`;
  const append = { action: 'append', content: '- New durable fact.' };
  const calls = [
    append,
    append,
    { action: 'read', target: 'daily' },
    { action: 'replace', old_text: verbose, new_text: 'Detail.' },
    append,
  ];
  const run = await runAgent(
    [
      ...calls.map((args, index) => ({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `memory-${index}`,
            type: 'function',
            function: { name: 'memory', arguments: JSON.stringify(args) },
          },
        ],
      })),
      { role: 'assistant', content: 'Task completed.' },
    ],
    { approvalMode: 'full' },
    { 'USER.md': '- **Timezone:** UTC\n' },
    {
      prepare: async (dir) => {
        fs.mkdirSync(path.join(dir, 'memory'));
        fs.writeFileSync(
          path.join(dir, `memory/${currentDateStampInTimezone('UTC')}.md`),
          original,
        );
        return {};
      },
    },
  );
  const executions = run.output.toolExecutions ?? [];
  expect(executions.map((execution) => execution.isError)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
  const errors = executions
    .slice(0, 2)
    .map((execution) =>
      JSON.parse(execution.result.slice(execution.result.indexOf('\n') + 1)),
    );
  expect(errors.map((error) => error.code)).toEqual([
    'MEMORY_CAPACITY_EXCEEDED',
    'MEMORY_RETRY_BLOCKED',
  ]);
  expect(errors[0]).toMatchObject({
    remaining_chars: 0,
    append_capacity_chars: 0,
    next_actions: ['read', 'replace'],
  });
  // Recovery details actually reach the next model request through IPC history.
  expect(JSON.stringify(run.requests)).toContain('MEMORY_RETRY_BLOCKED');
  const final = fs.readFileSync(
    path.join(run.dir, errors[0].file_path),
    'utf8',
  );
  expect(final).toContain(unique.trim());
  expect(final).toContain(append.content);
  expect(final.length).toBeLessThan(DAILY_MEMORY_MAX_CHARS);
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.result).toBe('Task completed.');
}, 20_000);
