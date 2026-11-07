import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('write-guard-family-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let workspace: string;
beforeEach(() => {
  workspace = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', workspace);
  for (const name of ['report.md', 'other.md']) fs.writeFileSync(path.join(workspace, name), 'Original\n');
});

async function worker(sessionId: string, rootSessionId?: string) {
  vi.resetModules();
  const guard = await import('../container/src/file-write-conflicts.js');
  guard.setFileWriteGuardSession(sessionId, rootSessionId);
  const { runFileWrite } = await import('../container/src/tools/file-write.js');
  const { TrustedAgentApprovalRuntime } = await import('../container/src/approval-policy.js');
  const approval = new TrustedAgentApprovalRuntime(
    ...['policy.yaml', 'agent.json', 'all.json', 'legacy.json'].map(name => path.join(workspace, name)) as [string, string, string, string],
  );
  approval.setSession(sessionId);
  approval.setApprovalMode({ mode: 'full' });
  return {
    guard,
    write: (args: Record<string, unknown>) => runFileWrite(args, name => path.join(workspace, name), undefined, sessionId),
    shell: (command = 'printf replacement > report.md') => approval.evaluateToolCall({ toolName: 'bash', argsJson: JSON.stringify({ command }) }),
  };
}

test.each([
  ['parent', 'child'], ['child', 'parent'], ['child', 'sibling'],
])('%s conflicts reach a warm %s worker', async (writerId, readerId) => {
  const reader = await worker(readerId, 'parent');
  expect(reader.shell().pinned).toBe(false);
  const writer = await worker(writerId, 'parent');
  await expect(writer.write({ path: 'report.md', contents: 'Replacement' })).rejects.toThrow();
  expect(reader.shell()).toMatchObject({ decision: 'required', pinned: true });
  expect(reader.shell('ls report.md')).toMatchObject({ decision: 'auto', pinned: false });
  expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe('Original\n');
});

test('checked recovery restores every family worker without affecting an unrelated conversation', async () => {
  const parent = await worker('parent');
  await expect(parent.write({ path: 'report.md', contents: 'Replacement' })).rejects.toThrow();
  const unrelated = await worker('unrelated');
  expect(unrelated.shell().pinned).toBe(false);
  const child = await worker('child', 'parent');
  expect(child.shell().pinned).toBe(true);
  await child.write({ path: 'report.md', contents: 'Revised', overwrite: true, expected_content: 'Original\n' });
  expect(parent.shell().pinned).toBe(false);
  expect((await worker('replacement-child', 'parent')).shell().pinned).toBe(false);
});

test('concurrent writers preserve both conflicts and resolve only their own path', async () => {
  const first = await worker('first', 'parent');
  const second = await worker('second', 'parent');
  const results = await Promise.allSettled([
    first.write({ path: 'report.md', contents: 'Replacement' }),
    second.write({ path: 'other.md', contents: 'Replacement' }),
  ]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  const parent = await worker('parent');
  expect(parent.shell().reason).toContain('report.md');
  expect(parent.shell().reason).toContain('other.md');
  await first.write({ path: 'report.md', contents: 'Revised', overwrite: true, expected_content: 'Original\n' });
  expect(parent.shell().reason).not.toContain('report.md');
  expect(parent.shell().reason).toContain('other.md');
  await second.write({ path: 'other.md', contents: 'Revised', overwrite: true, expected_content: 'Original\n' });
  expect(parent.shell().pinned).toBe(false);
});

test.each(['locked', 'corrupt'])('a warm worker fails closed on %s shared state', async state => {
  const parent = await worker('parent');
  expect(parent.shell().pinned).toBe(false);
  const { sessionStatePath } = await import('../container/src/session-state.js');
  const file = sessionStatePath('parent', 'file-write-conflicts.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state === 'locked') fs.mkdirSync(`${file}.lock`);
  else fs.writeFileSync(file, 'invalid');
  expect(parent.shell().decision).toBe('denied');
});

test.each(['', ' ', null, 12])('malformed trusted guard context fails closed: %j', async value => {
  const { guard } = await worker('parent');
  expect(() => guard.setFileWriteGuardSession('child', value as string)).toThrow();
});

test('failed shared-state updates release the lock and keep the worker fail-closed', async () => {
  const { SessionStateSet, sessionStatePath } = await import('../container/src/session-state.js');
  const store = new SessionStateSet('fixture-required.json', true);
  store.bindSession('parent');
  const file = sessionStatePath('parent', 'fixture-required.json');
  fs.mkdirSync(file, { recursive: true });
  await expect(store.updateLockedSession('parent', 'add', 'report.md')).rejects.toThrow(/could not be updated/);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
  fs.rmdirSync(file);
  expect(() => store.bindSession('parent', true)).toThrow(/could not be updated/);
});
