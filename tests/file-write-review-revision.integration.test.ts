import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const original = 'Garden notes\nWater weekly.\n';
const replacement = 'Release notes\nAdded offline mode.\n';
const revision = createHash('sha256').update(original).digest('hex');

function call(id: string, args: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify(args) },
      },
    ],
  };
}

test.each([false, true])(
  'a real worker reviews a hash replacement, allowed=%s',
  async (allowed) => {
    let primary = 0;
    let reviews = 0;
    let rejected = false;
    const run = await runAgent(
      async (body) => {
        if ((body.tools ?? []).length === 0) {
          const review = JSON.parse(String(body.messages.at(-1)?.content));
          expect(review).toMatchObject({
            path: 'report.md',
            existing_content: original,
            proposed_content: replacement,
          });
          reviews++;
          return {
            role: 'assistant',
            content: JSON.stringify({
              decision: allowed ? 'allow' : 'reject',
              reason: allowed
                ? 'Requested replacement'
                : 'Unrelated new deliverable',
            }),
          };
        }
        switch (primary++) {
          case 0:
            return call('create', { path: 'report.md', contents: replacement });
          case 1:
            return call('backup', {
              path: 'garden-backup.md',
              contents: original,
            });
          case 2:
            return call('replace', {
              path: 'report.md',
              contents: replacement,
              overwrite: true,
              expected_sha256: revision,
            });
          case 3:
            rejected =
              body.messages.at(-1)?.role === 'tool' &&
              body.messages.at(-1)?.is_error === true;
            return call('separate', {
              path: 'release-notes.md',
              contents: replacement,
            });
          default:
            return { role: 'assistant', content: 'Finished permitted work.' };
        }
      },
      {
        approvalMode: 'full',
        messages: [
          {
            role: 'user',
            content: allowed
              ? 'Replace the garden notes in report.md with software release notes.'
              : 'Create software release notes in report.md.',
          },
        ],
      },
      { 'report.md': original },
    );
    expect(reviews).toBe(1);
    expect(rejected).toBe(!allowed);
    expect(run.output.pendingApproval).toBeUndefined();
    expect(run.output.status).toBe('success');
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      allowed ? replacement : original,
    );
    expect(
      fs.readFileSync(path.join(run.dir, 'garden-backup.md'), 'utf8'),
    ).toBe(original);
    expect(
      fs.readFileSync(path.join(run.dir, 'release-notes.md'), 'utf8'),
    ).toBe(replacement);
    expect(
      run.output.toolExecutions?.some(
        (row) =>
          row.blocked &&
          row.approvalActionKey?.startsWith('file-preservation-review:'),
      ),
    ).toBe(!allowed);
  },
  20000,
);
