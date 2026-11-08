import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('browser-export-worker-');
const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });
beforeEach(() => {
  const browser = path.join(temporary(), 'browser.mjs');
  fs.writeFileSync(
    browser,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
const expression=args[args.indexOf('--json')+2];
const result=expression==='location.href' ? 'https://example.com' :
 expression.includes('document.title') ? {url:'https://example.com',title:'Fixture'} : 'Browser export';
process.stdout.write(JSON.stringify({success:true,data:{result}}));
`,
  );
  fs.chmodSync(browser, 0o755);
  vi.stubEnv('AGENT_BROWSER_BIN', browser);
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', '');
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', '');
});
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
const overrides = {
  approvalMode: 'full' as const,
  allowedTools: ['browser_evaluate', 'write', 'read'],
  messages: [
    {
      role: 'user' as const,
      content: 'Update the existing report with the rendered export.',
    },
  ],
};

test('the real worker preserves a conflicting file and saves a separate browser export', async () => {
  const run = await runAgent(
    [
      call('conflict', 'write', {
        path: 'existing.txt',
        contents: 'Replacement',
      }),
      call('blocked-export', 'browser_evaluate', {
        expression: '"Browser export"',
        path: 'existing.txt',
      }),
      call('separate-export', 'browser_evaluate', {
        expression: '"Browser export"',
        path: 'new.txt',
      }),
      { role: 'assistant', content: 'Completed.' },
    ],
    overrides,
    { 'existing.txt': 'Original fixture' },
  );
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(
    run.output.toolExecutions?.find((e) => e.toolCallId === 'blocked-export')
      ?.isError,
  ).toBe(true);
  expect(
    run.output.toolExecutions?.find((e) => e.toolCallId === 'separate-export')
      ?.isError,
  ).toBe(false);
  expect(fs.readFileSync(path.join(run.dir, 'existing.txt'), 'utf8')).toBe(
    'Original fixture',
  );
  expect(fs.readFileSync(path.join(run.dir, 'new.txt'), 'utf8')).toBe(
    'Browser export',
  );
});

test('a browser collision still permits an authorized checked replacement', async () => {
  const run = await runAgent(
    [
      call('blocked-export', 'browser_evaluate', {
        expression: '"Browser export"',
        path: 'existing.txt',
      }),
      call('checked', 'write', {
        path: 'existing.txt',
        contents: 'Browser export',
        overwrite: true,
        expected_content: 'Original fixture',
      }),
      {
        role: 'assistant',
        content: '{"decision":"allow","reason":"Requested update"}',
      },
      { role: 'assistant', content: 'Completed.' },
    ],
    overrides,
    { 'existing.txt': 'Original fixture' },
  );
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(
    run.output.toolExecutions?.find((e) => e.toolCallId === 'blocked-export')
      ?.isError,
  ).toBe(true);
  expect(
    run.output.toolExecutions?.find((e) => e.toolCallId === 'checked')?.isError,
  ).toBe(false);
  expect(fs.readFileSync(path.join(run.dir, 'existing.txt'), 'utf8')).toBe(
    'Browser export',
  );
});
