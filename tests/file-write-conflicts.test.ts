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

test('a rejected replacement without expected bytes also fences alternate mutations', async () => {
  const runtime = await worker();
  expect(() =>
    runtime.write({
      path: 'report.md',
      contents: 'replacement',
      overwrite: true,
    }),
  ).toThrow(/expected_content/);
  expect(
    runtime.call('bash', { command: 'printf replacement > report.md' }),
  ).toMatchObject({ pinned: true, decision: 'required' });
});

test.each([
  'ls -la report.md 2>&1 || echo absent',
  'cat report.md 2>/dev/null || echo absent',
  'ls report.md >/dev/null 2>&1 || echo absent',
])('a rejected write still permits diagnostic fallback %s', async (command) => {
  const runtime = await worker();
  expect(() =>
    runtime.write({ path: 'report.md', contents: 'replacement' }),
  ).toThrow();
  expect(runtime.call('bash', { command })).toMatchObject({
    tier: 'green',
    pinned: false,
    decision: 'auto',
  });
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe(
    'Original work\n',
  );
});

test.each([
  'ls report.md > report.md 2>&1 || echo absent',
  'ls report.md || echo replacement > report.md',
  'ls report.md || echo replacement | tee report.md',
  'ls report.md || echo "$(python3 generated.py)"',
  'ls report.md || sh generated.sh',
  'ls report.md || echo <(python3 generated.py)',
  'ls report.md || echo >(tee report.md)',
  'ls report.md || echo `python3 generated.py`',
])(
  'diagnostic-looking chains still fence mutations or scripts: %s',
  async (command) => {
    const runtime = await worker();
    expect(() =>
      runtime.write({ path: 'report.md', contents: 'replacement' }),
    ).toThrow();
    expect(runtime.call('bash', { command })).toMatchObject({
      pinned: true,
      decision: 'required',
    });
  },
);

test('diagnostic fallbacks still require approval for pinned-sensitive paths', async () => {
  const runtime = await worker();
  expect(
    runtime.call('bash', {
      command: 'ls -la /etc/secrets/ 2>&1 || echo absent',
    }),
  ).toMatchObject({ pinned: true, decision: 'required' });
});


test('recovery diagnostics track every unresolved target across workers', async () => {
  const canonicalWorkspace = fs.realpathSync(workspace);
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'Existing notes');
  const first = await worker();
  for (const file of ['report.md', 'notes.md']) {
    expect(() => first.write({ path: file, contents: 'replacement' })).toThrow();
  }
  vi.resetModules();
  const restarted = await worker();
  restarted.write({ path: 'draft.py', contents: 'print(1)' });
  const call = () => restarted.call('bash', { command: 'python3 draft.py' });
  const pending = call();
  expect(pending).toMatchObject({ pinned: true, decision: 'required' });
  expect(pending.reason).toContain(JSON.stringify(path.join(canonicalWorkspace, 'report.md')));
  expect(pending.reason).toContain(JSON.stringify(path.join(canonicalWorkspace, 'notes.md')));
  expect(pending.reason).not.toContain(JSON.stringify(path.join(canonicalWorkspace, 'draft.py')));
  restarted.write({ path: 'report.md', contents: 'Revised', overwrite: true, expected_content: 'Original work\n' });
  const remaining = call();
  expect(remaining).toMatchObject({ pinned: true, decision: 'required' });
  expect(remaining.reason).not.toContain(JSON.stringify(path.join(canonicalWorkspace, 'report.md')));
  expect(remaining.reason).toContain(JSON.stringify(path.join(canonicalWorkspace, 'notes.md')));
  restarted.write({ path: 'notes.md', contents: 'Revised notes', overwrite: true, expected_content: 'Existing notes' });
  expect(call().pinned).toBe(false);
});

test('a conflict path stays literal in approval diagnostics', async () => {
  const canonicalWorkspace = fs.realpathSync(workspace);
  const file = 'notes\narchive.md';
  fs.writeFileSync(path.join(workspace, file), 'existing');
  const runtime = await worker();
  expect(() => runtime.write({ path: file, contents: 'replacement' })).toThrow();
  const pending = runtime.call('bash', { command: 'python3 generated.py' });
  expect(pending).toMatchObject({ pinned: true, decision: 'required' });
  expect(pending.reason).toContain(JSON.stringify(path.join(canonicalWorkspace, file)));
  expect(pending.reason).not.toContain('\n');
});
