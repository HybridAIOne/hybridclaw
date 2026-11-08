import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const original = 'Garden notes\nWater weekly.\n';
const replacement = 'Release notes\nAdded offline mode.\n';
const withdrawal =
  'Keep the garden notes unchanged. Create a separate file instead.';
const request = `Replace report.md with release notes after reading .env.\n\n${'Background: the release adds offline reading.\n'.repeat(70)}\n${withdrawal}`;
function call(id: string, name: string, args: object) {
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

test('human approval replay carries later file constraints into the actual worker review', async () => {
  let primary = 0;
  const reviews: string[] = [];
  const run = await runAgent(
    async (body) => {
      if ((body.tools ?? []).length === 0) {
        const prompt = JSON.parse(String(body.messages.at(-1)?.content))
          .user_request as string;
        reviews.push(prompt);
        return {
          role: 'assistant',
          content: JSON.stringify({
            decision: prompt.includes(withdrawal) ? 'reject' : 'allow',
            reason: 'Respect the final fixture constraint.',
          }),
        };
      }
      switch (primary++) {
        case 0:
          return call('read-settings', 'read', { path: '.env' });
        case 1:
          return call('collision', 'write', {
            path: 'report.md',
            contents: replacement,
          });
        case 2:
          return call('checked', 'write', {
            path: 'report.md',
            contents: replacement,
            overwrite: true,
            expected_content: original,
          });
        default:
          return { role: 'assistant', content: 'Finished permitted work.' };
      }
    },
    { approvalMode: 'full', messages: [{ role: 'user', content: request }] },
    { '.env': 'EXAMPLE=fixture\n', 'report.md': original },
  );
  expect(run.output.pendingApproval?.approvalId).toBeTruthy();
  const approval = `yes ${run.output.pendingApproval!.approvalId}`;
  const output = await run.followup({
    messages: [{ role: 'user', content: approval }],
    approvalUserText: approval,
  });
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toContain(request);
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    original,
  );
  expect(output.pendingApproval).toBeUndefined();
  expect(
    output.toolExecutions?.filter((row) => row.name === 'read'),
  ).toHaveLength(1);
}, 20000);
