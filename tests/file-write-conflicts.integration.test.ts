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

test('the real dispatcher stops a shell overwrite after failed replacement preconditions', async () => {
  const run = await runAgent(
    [
      call('write-1', 'write', { path: 'report.md', contents: 'Replacement' }),
      call('write-2', 'write', {
        path: 'report.md',
        contents: 'Replacement',
        overwrite: true,
        expected_content: 'Stale',
      }),
      call('shell-1', 'bash', {
        command: "cat > report.md <<'EOF'\nReplacement\nEOF",
      }),
    ],
    { approvalMode: 'full' },
    { 'report.md': 'Original work\n' },
  );
  expect(run.output.pendingApproval).toMatchObject({
    toolName: 'bash',
    allowSession: false,
    allowAgent: false,
    allowAll: false,
  });
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Original work\n',
  );
}, 20000);

test('the real dispatcher allows recovery into a separate deliverable', async () => {
  const run = await runAgent(
    [
      call('write-1', 'write', { path: 'report.md', contents: 'Replacement' }),
      call('write-2', 'write', {
        path: 'report-new.md',
        contents: 'New deliverable',
      }),
    ],
    { approvalMode: 'full' },
    { 'report.md': 'Original work\n' },
  );
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.status).toBe('success');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Original work\n',
  );
  expect(fs.readFileSync(path.join(run.dir, 'report-new.md'), 'utf8')).toBe(
    'New deliverable',
  );
}, 20000);
