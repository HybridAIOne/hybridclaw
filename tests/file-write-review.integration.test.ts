import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

test.each(['write', 'edit'])(
  'the real worker rejects an unrelated %s and completes at a separate path',
  async (tool) => {
    const original = 'Garden notes\nWater weekly.\n';
    let primary = 0;
    let reviews = 0;
    let rejected = false;
    const run = await runAgent(
      async (body) => {
        const last = body.messages.at(-1);
        if ((body.tools ?? []).length === 0) {
          const review = JSON.parse(String(last?.content));
          expect(review).toMatchObject({
            path: 'report.md',
            existing_content: original,
          });
          reviews++;
          return {
            role: 'assistant',
            content:
              '{"decision":"reject","reason":"This is a different document. Create a separate file."}',
          };
        }
        switch (primary++) {
          case 0:
            return call('create', 'write', {
              path: 'report.md',
              contents: 'Release notes',
            });
          case 1:
            return tool === 'write'
              ? call('replace', 'write', {
                  path: 'report.md',
                  contents: 'Release notes',
                  overwrite: true,
                  expected_content: original,
                })
              : call('append', 'edit', {
                  path: 'report.md',
                  old: original,
                  new: original + 'Release notes',
                });
          case 2:
            rejected = last?.role === 'tool' && last.is_error === true;
            return call('separate', 'write', {
              path: 'release-notes.md',
              contents: 'Release notes',
            });
          default:
            return { role: 'assistant', content: 'Saved release-notes.md.' };
        }
      },
      {
        approvalMode: 'full',
        messages: [
          {
            role: 'user',
            content: 'Create software release notes in report.md.',
          },
        ],
      },
      { 'report.md': original },
    );
    expect.soft(reviews).toBe(1);
    expect.soft(rejected).toBe(true);
    expect(run.output.pendingApproval).toBeUndefined();
    expect(run.output.status).toBe('success');
    expect
      .soft(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8'))
      .toBe(original);
    expect(
      fs.readFileSync(path.join(run.dir, 'release-notes.md'), 'utf8'),
    ).toBe('Release notes');
    expect(
      run.output.toolExecutions?.some(
        (row) =>
          row.blocked &&
          row.approvalActionKey?.startsWith('file-preservation-review:'),
      ),
    ).toBe(true);
  },
  20000,
);

test('repeated rejected replacements end without a mutation or a human-approval prompt', async () => {
  let primary = 0;
  let reviews = 0;
  const run = await runAgent(
    async (body) => {
      if ((body.tools ?? []).length === 0) {
        reviews++;
        return {
          role: 'assistant',
          content: '{"decision":"reject","reason":"Unrelated document"}',
        };
      }
      if (primary >= 4)
        return { role: 'assistant', content: 'Stopped the fixture.' };
      return primary++ === 0
        ? call('create', 'write', {
            path: 'report.md',
            contents: 'Release notes',
          })
        : call(`replace-${primary}`, 'write', {
            path: './report.md',
            contents: 'Release notes',
            overwrite: true,
            expected_content: 'Garden notes',
          });
    },
    { approvalMode: 'full' },
    { 'report.md': 'Garden notes' },
  );
  expect(reviews).toBe(2);
  expect(primary).toBe(3);
  expect(run.output.pendingApproval).toBeUndefined();
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Garden notes',
  );
}, 20000);
