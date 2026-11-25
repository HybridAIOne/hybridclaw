import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const protectedCall = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'protected',
      type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: '.env' }) },
    },
  ],
};

test('denial resumes permitted work without executing or granting the protected call', async () => {
  let calls = 0;
  const worker = await run(
    async (body) => {
      calls++;
      if (calls === 1 || calls === 4) return protectedCall;
      if (calls === 2) {
        expect(body.messages?.at(-1)?.content).toContain(
          'Fixture original request',
        );
        expect(JSON.stringify(body.messages)).not.toContain(
          'fixture-private-value',
        );
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'permitted',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({
                  path: 'result.txt',
                  contents: 'Fixture artifact',
                }),
              },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'Finished permitted work.' };
    },
    {
      approvalMode: 'full',
      approvalUserId: 'user_a',
      approvalUserText: 'Fixture original request',
      messages: [{ role: 'user', content: 'Fixture original request' }],
    },
    { '.env': 'fixture-private-value' },
  );
  const approvalId = worker.output.pendingApproval?.approvalId;
  expect(approvalId).toBeTruthy();
  expect(calls).toBe(1);
  const denied = await worker.followup({
    approvalUserText: `no ${approvalId}`,
    messages: [{ role: 'user', content: `no ${approvalId}` }],
  });
  expect(denied.status).toBe('success');
  expect(denied.pendingApproval).toBeUndefined();
  expect(denied.toolsUsed).toEqual(['write']);
  expect(fs.readFileSync(path.join(worker.dir, 'result.txt'), 'utf8')).toBe(
    'Fixture artifact',
  );
  expect(calls).toBe(3);
  const retry = await worker.followup({
    approvalUserText: 'Fixture retry',
    messages: [{ role: 'user', content: 'Fixture retry' }],
  });
  expect(retry.pendingApproval?.toolName).toBe('read');
  expect(calls).toBe(4);
});
