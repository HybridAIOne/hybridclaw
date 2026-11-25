import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useTempDir } from './test-utils.js';

const run = useContainerAgentHarness();
const makeTempDir = useTempDir('grep-file-replan-');

function bashCall(id: string, command: string) {
  return {
    id,
    type: 'function' as const,
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

test('an unattended full-auto turn can omit a protected step and finish', async () => {
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('protected', 'printf skipped-prefix; cat .env')],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('safe', 'printf continued')],
      },
      { role: 'assistant', content: 'Finished.' },
    ],
    { approvalMode: 'full', approvalUserIsBot: true },
    { '.env': 'VALUE=test-key\n' },
  );
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    approvalDecision: 'denied',
    blocked: true,
  });
  expect(worker.output.toolExecutions?.[1]?.result).toBe('continued');
  const denial = worker.requests[1].messages?.find(
    (message) => message.role === 'tool',
  );
  expect(denial?.content).toContain('Nothing in this tool call ran');
  expect(denial?.content).not.toContain('test-key');
});

test('bounds unattended replans for repeated approval-required calls', async () => {
  const worker = await run(
    Array.from({ length: 5 }, (_, i) => ({
      role: 'assistant',
      content: null,
      tool_calls: [bashCall(`repeated-${i}`, 'cat .env')],
    })),
    { approvalMode: 'full', approvalUserIsBot: true },
    { '.env': 'VALUE=test-key\n' },
  );
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.requests).toHaveLength(4);
  expect(
    worker.output.toolExecutions?.map((call) => call.approvalDecision),
  ).toEqual(['denied', 'denied', 'denied', 'denied']);
});

test('a compound grep denial allows a named-file retry without executing the original batch', async () => {
  const dir = fs.realpathSync(makeTempDir());
  const source = path.join(dir, 'model.py');
  fs.writeFileSync(source, 'parameter = 42\n');
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('combined', `echo ORIGINAL_PREFIX; grep -rn parameter ${dir}/*.py 2>/dev/null | head`)],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('named-file', `grep -n -- parameter ${source}`)],
      },
      { role: 'assistant', content: 'Found the parameter.' },
    ],
    { approvalMode: 'full' },
  );

  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    approvalActionKey: 'bash:grep-file-search',
    approvalDecision: 'denied',
    blocked: true,
  });
  expect(worker.output.toolExecutions?.[1]?.result).toContain('parameter = 42');
  const recovery = worker.requests[1].messages?.find((message) => message.role === 'tool');
  expect(recovery?.content).toContain('grep -n');
  expect(recovery?.content).not.toContain('ORIGINAL_PREFIX');
});

test('pip and directory-search diagnostics each recover once without prompting', async () => {
  const dir = fs.realpathSync(makeTempDir());
  const pkg = path.join(dir, 'site-packages', 'example');
  fs.mkdirSync(pkg, { recursive: true });
  const source = path.join(pkg, 'model.py');
  fs.writeFileSync(source, 'parameter = 42\n');
  fs.writeFileSync(path.join(pkg, '.env'), 'parameter = private-value\n');
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall(
          'pip-config',
          'pip config list 2>/dev/null; cat /etc/pip.conf 2>/dev/null; curl -sI https://pypi.org/simple/example/ | head -3',
        )],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('directory', `grep -rn parameter ${pkg}/ | grep -v pyc | head`)],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('named-file', `grep -n -- parameter ${source}`)],
      },
      { role: 'assistant', content: 'Found the parameter.' },
    ],
    { approvalMode: 'full' },
  );

  expect(worker.output.pendingApproval).toBeUndefined();
  expect(
    worker.output.toolExecutions?.slice(0, 2).map((call) => call.approvalDecision),
  ).toEqual(['denied', 'denied']);
  expect(worker.output.toolExecutions?.at(-1)?.result).toContain('parameter = 42');
  expect(JSON.stringify(worker.output.toolExecutions)).not.toContain('private-value');
});
