import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('an oversized backup expression stops before the worker executes it', async () => {
  const command = `sed -i'${'*'.repeat(16384)}' 's/before/after/' notes.txt`;
  const run = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'oversized',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command }) },
          },
        ],
      },
      { role: 'assistant', content: 'Finished.' },
    ],
    { approvalMode: 'full' },
    { 'notes.txt': 'before\n' },
  );
  expect(run.output.toolExecutions?.[0]).toMatchObject({ isError: true });
  expect(run.output.toolExecutions?.[0].result).toMatch(
    /backup.*inspection limit/i,
  );
  expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
    'before\n',
  );
  const followup = await run.followup({
    messages: [
      { role: 'user', content: 'Continue without the rejected edit.' },
    ],
  });
  expect(followup.status).toBe('success');
});

test.each([
  "sed -Ei'.env*' 's/before/after/' notes.txt",
  "find . -name notes.txt -exec sed -Ei'.env*' 's/before/after/' {} +",
])('a real worker blocks a protected backup: %s', async (command) => {
  const run = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'backup',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command }) },
          },
        ],
      },
      { role: 'assistant', content: 'Finished.' },
    ],
    { approvalMode: 'full' },
    { 'notes.txt': 'before\n' },
  );
  expect(run.output.pendingApproval).toBeDefined();
  expect(run.output.toolExecutions?.[0]).toMatchObject({ blocked: true });
  expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
    'before\n',
  );
  expect(fs.existsSync(path.join(run.dir, '.envnotes.txt'))).toBe(false);
});

test.each(
  [
    "sed -i.bak 's/before/after/'",
    "sed -Ei.bak 's/before/after/'",
    "env -u FEATURE sed -i.bak 's/before/after/'",
    'sed -i.bak -f script.sed',
  ].flatMap((prefix) => [true, false].map((outside) => ({ prefix, outside }))),
)(
  'real in-place edits preserve the boundary: $prefix outside=$outside',
  async ({ prefix, outside }) => {
    const target = outside
      ? '/opt/hybridclaw-policy-fixture-missing/notes.txt'
      : 'notes.txt';
    if (outside) expect(fs.existsSync(target)).toBe(false);
    let command = '';
    let requests = 0;
    const run = await runAgent(
      async () =>
        ++requests === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'edit',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({ command }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Finished.' },
      { approvalMode: 'full' },
      { 'notes.txt': 'before\n', 'script.sed': 's/before/after/\n' },
      {
        prepare: async (dir) => {
          const log = path.join(dir, 'edit.log').replaceAll("'", "'\\''");
          command = `${prefix} ${target} > '${log}' 2>&1`;
          return {};
        },
      },
    );
    if (outside) {
      expect(run.output.pendingApproval).toBeDefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({ blocked: true });
      expect(fs.existsSync(path.join(run.dir, 'edit.log'))).toBe(false);
      expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
        'before\n',
      );
      expect(fs.existsSync(target)).toBe(false);
    } else {
      expect(run.output.pendingApproval).toBeUndefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({
        blocked: false,
        isError: false,
      });
      expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
        'after\n',
      );
      expect(fs.readFileSync(path.join(run.dir, 'notes.txt.bak'), 'utf8')).toBe(
        'before\n',
      );
    }
  },
);
