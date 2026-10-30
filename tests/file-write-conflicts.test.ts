import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('file-write-conflicts-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let workspace: string;
beforeEach(() => {
  workspace = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', workspace);
  fs.writeFileSync(path.join(workspace, 'report.md'), 'Original work\n');
});

async function worker(sessionId = 'session-a') {
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const approval = new TrustedAgentApprovalRuntime(
    path.join(workspace, 'policy.yaml'),
    path.join(workspace, 'agent.json'),
    path.join(workspace, 'all.json'),
    path.join(workspace, 'legacy.json'),
    undefined,
    path.join(workspace, 'pending.json'),
  );
  approval.setSession(sessionId);
  approval.setApprovalMode({ mode: 'full' });
  return {
    write: (args: Record<string, unknown>) =>
      runFileWrite(
        args,
        (file) => path.join(workspace, file),
        undefined,
        sessionId,
      ),
    approval,
    call: (toolName: string, args: Record<string, unknown>) =>
      approval.evaluateToolCall({ toolName, argsJson: JSON.stringify(args) }),
  };
}

test.each([
  "cat > report.md <<'EOF'\nReplacement\nEOF",
  'printf replacement > report.md',
  'printf replacement | tee report.md',
  'cp alternative.md report.md',
  'cat report.md > report.md',
  'sed -i s/Original/Replacement/ report.md',
  'echo $(python3 generated.py)',
  'find . -exec sh generated.sh \; ',
  'rm report.md && printf replacement > report.md',
  "python3 -c \"open('report.md', 'w').write('replacement')\"",
  'python3 generated.py',
  "node -e \"require('fs').writeFileSync('report.md','replacement')\"",
  'target=report.md; printf replacement > "$target"',
  'sh -c "printf replacement > report.md"',
])('a failed write cannot silently recover with %s', async (command) => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  expect(runtime.call('bash', { command })).toMatchObject({
    tier: 'red',
    pinned: true,
    decision: 'required',
  });
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe(
    'Original work\n',
  );
});

test('read-only diagnostics and a new deliverable stay available', async () => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  expect(runtime.call('bash', { command: 'ls -l report.md' })).toMatchObject({
    pinned: false,
    decision: 'auto',
  });
  expect(
    runtime.write({ path: 'report-new.md', contents: 'New work' }),
  ).toContain('Wrote');
  expect(
    runtime.call('bash', { command: 'printf replacement > report.md' }),
  ).toMatchObject({ pinned: true, decision: 'required' });
});

test('a checked replacement resolves its conflict and restores normal shell policy', async () => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  expect(() =>
    runtime.write({
      path: 'report.md',
      contents: 'replacement',
      overwrite: true,
      expected_content: 'wrong',
    }),
  ).toThrow(/Stale/);
  runtime.write({
    path: 'report.md',
    contents: 'Revised',
    overwrite: true,
    expected_content: 'Original work\n',
  });
  expect(
    runtime.call('bash', { command: 'printf updated > report.md' }).pinned,
  ).toBe(false);
});

test('the conflict survives worker replacement and is isolated by session', async () => {
  const first = await worker();
  expect(() =>
    first.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  vi.resetModules();
  const restarted = await worker();
  expect(
    restarted.call('bash', { command: 'printf replacement > report.md' }),
  ).toMatchObject({ pinned: true, decision: 'required' });
  const other = await worker('session-b');
  expect(
    other.call('bash', { command: 'printf replacement > report.md' }).pinned,
  ).toBe(false);
});

test('deleting the conflicted file also requires one-time approval', async () => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  expect(runtime.call('delete', { path: 'report.md' })).toMatchObject({
    pinned: true,
    decision: 'required',
  });
  expect(runtime.call('delete', { path: 'unrelated.tmp' }).pinned).toBe(false);
});

test('corrupt required state fails closed instead of forgetting the conflict', async () => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  const { sessionStatePath } = await import(
    '../container/src/session-state.js'
  );
  fs.writeFileSync(
    sessionStatePath('session-a', 'file-write-conflicts.json'),
    'broken json',
  );
  vi.resetModules();
  const restarted = await worker();
  expect(
    restarted.call('bash', { command: 'printf replacement > report.md' })
      .decision,
  ).toBe('denied');
});

test('sandbox write failures fence the same session', async () => {
  const runtime = await worker();
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  expect(() =>
    runFileWrite(
      { path: 'report.md', contents: 'replacement' },
      () => '/workspace/report.md',
      {
        container: 'fixture',
        run: () => ({ status: 1, stdout: '', stderr: 'Existing file' }),
      },
      'session-a',
    ),
  ).toThrow();
  expect(runtime.call('bash', { command: 'cat > report.md' })).toMatchObject({
    pinned: true,
    decision: 'required',
  });
});

test('a session approval permits only one execution of a conflicted shell action', async () => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  const args = { command: 'printf replacement > report.md' };
  const blocked = runtime.call('bash', args);
  expect(blocked.requestId).toBeDefined();
  runtime.approval.resolveApprovalResponse({
    kind: 'approve',
    requestId: blocked.requestId!,
    mode: 'session',
  });
  expect(runtime.call('bash', args).decision).toBe('approved_once');
  expect(runtime.call('bash', args).decision).toBe('required');
});

test('a required store latches persistence failures', async () => {
  const { SessionStateSet, sessionStatePath } = await import(
    '../container/src/session-state.js'
  );
  const store = new SessionStateSet('fixture.json', true);
  store.bindSession('broken');
  const state = sessionStatePath('broken', 'fixture.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.mkdirSync(state);
  expect(() => store.add('protected')).toThrow(/persisted/);
  expect(() => store.bindSession('broken')).toThrow(/persisted/);
  expect(() => store.delete('protected')).toThrow(/persisted/);
});

test('deleting a parent or a symlink alias cannot bypass a recorded conflict', async () => {
  const runtime = await worker();
  fs.mkdirSync(path.join(workspace, 'nested'));
  fs.writeFileSync(path.join(workspace, 'nested/report.md'), 'original');
  fs.symlinkSync(
    path.join(workspace, 'nested/report.md'),
    path.join(workspace, 'alias.md'),
  );
  expect(() =>
    runtime.write({ path: 'alias.md', contents: 'replacement' }),
  ).toThrow();
  expect(runtime.call('delete', { path: 'nested' })).toMatchObject({
    pinned: true,
    decision: 'required',
  });
  expect(runtime.call('delete', { path: 'alias.md' })).toMatchObject({
    pinned: true,
    decision: 'required',
  });
});
