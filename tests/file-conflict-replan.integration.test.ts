import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

test('a blocked backup copy permits safe continuation without copying or changing the original', async () => {
  const run = await runAgent(
    [
      call('collision', 'write', {
        path: 'report.md',
        contents: 'New release notes',
      }),
      call('backup', 'bash', { command: 'cp report.md report-backup.md' }),
      call('separate', 'write', {
        path: 'release-notes.md',
        contents: 'New release notes',
      }),
      { role: 'assistant', content: 'Completed.' },
    ],
    { approvalMode: 'full' },
    { 'report.md': 'Existing garden notes\n' },
  );
  expect(run.output.result).toBe('Completed.');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.toolExecutions?.[1]).toMatchObject({
    blocked: true,
    approvalDecision: 'denied',
  });
  expect(fs.existsSync(path.join(run.dir, 'report-backup.md'))).toBe(false);
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Existing garden notes\n',
  );
  expect(fs.readFileSync(path.join(run.dir, 'release-notes.md'), 'utf8')).toBe(
    'New release notes',
  );
}, 20_000);

test('a repeated mutation still pauses and does not run either command', async () => {
  const run = await runAgent(
    [
      call('collision', 'write', {
        path: 'report.md',
        contents: 'New release notes',
      }),
      call('first', 'bash', { command: 'cp report.md report-backup.md' }),
      call('second', 'bash', { command: 'printf replacement > report.md' }),
      { role: 'assistant', content: 'Should not complete.' },
    ],
    { approvalMode: 'full' },
    { 'report.md': 'Existing garden notes\n' },
  );
  expect(run.output.pendingApproval?.toolName).toBe('bash');
  expect(run.output.toolExecutions?.at(-1)?.arguments).toContain(
    'printf replacement',
  );
  expect(
    run.output.toolExecutions?.slice(-2).map((row) => row.blocked),
  ).toEqual([true, true]);
  expect(fs.existsSync(path.join(run.dir, 'report-backup.md'))).toBe(false);
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Existing garden notes\n',
  );
}, 20_000);

test.each(['allow', 'reject'] as const)(
  'checked file changes still receive independent preservation review after recovery: %s',
  async (verdict) => {
    const original = 'Existing garden notes\n';
    const proposed =
      verdict === 'allow'
        ? original + 'Watering complete.\n'
        : 'Unrelated release notes\n';
    const run = await runAgent(
      [
        call('collision', 'write', { path: 'report.md', contents: proposed }),
        call('backup', 'bash', { command: 'cp report.md report-backup.md' }),
        call('checked', 'write', {
          path: 'report.md',
          contents: proposed,
          overwrite: true,
          expected_content: original,
        }),
        {
          role: 'assistant',
          content: JSON.stringify({
            decision: verdict,
            reason:
              verdict === 'allow'
                ? 'Requested update'
                : 'Unrelated replacement',
          }),
        },
        ...(verdict === 'allow'
          ? [
              call('continue', 'bash', {
                command: 'printf completed > completion.txt',
              }),
            ]
          : [
              call('separate', 'write', {
                path: 'release-notes.md',
                contents: proposed,
              }),
            ]),
        { role: 'assistant', content: 'Completed.' },
      ],
      {
        approvalMode: 'full',
        messages: [
          {
            role: 'user',
            content:
              verdict === 'allow'
                ? 'Append a watering-complete note to the existing garden notes.'
                : 'Create new release notes.',
          },
        ],
      },
      { 'report.md': original },
    );
    expect(run.output.result).toBe('Completed.');
    expect(run.output.pendingApproval).toBeUndefined();
    expect(fs.existsSync(path.join(run.dir, 'report-backup.md'))).toBe(false);
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      verdict === 'allow' ? proposed : original,
    );
    if (verdict === 'allow')
      expect(
        fs.readFileSync(path.join(run.dir, 'completion.txt'), 'utf8'),
      ).toBe('completed');
    else
      expect(
        fs.readFileSync(path.join(run.dir, 'release-notes.md'), 'utf8'),
      ).toBe(proposed);
  },
  20_000,
);
