import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const makeDir = useTempDir('hy-approval-boundary-');
useCleanMocks({ restoreAllMocks: true });
const call = {
  toolName: 'read',
  argsJson: JSON.stringify({ path: '.env' }),
  latestUserPrompt: 'Review settings',
};
function worker(dir: string, session = 'session-a', user = 'user-a') {
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'policy.yaml'),
    path.join(dir, 'agent.json'),
    path.join(dir, 'workspace.json'),
    path.join(dir, 'legacy.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setSession(session, user);
  runtime.setApprovalMode({ mode: 'full' });
  return runtime;
}

test('persisted pinned requests reject wrong sessions and users and remain one-time after restart', () => {
  const dir = makeDir();
  const request = worker(dir).evaluateToolCall(call);
  expect(request.decision).toBe('required');
  const reply = [
    { role: 'user' as const, content: `yes ${request.requestId} for all` },
  ];
  expect(worker(dir, 'session-b').handleApprovalResponse(reply)).toBeNull();
  expect(
    worker(dir, 'session-a', 'user-b').handleApprovalResponse(reply),
  ).toBeNull();
  const restarted = worker(dir);
  expect(restarted.handleApprovalResponse(reply)).toMatchObject({
    approvalMode: 'once',
    approvedToolCall: { toolName: call.toolName, argsJson: call.argsJson },
  });
  expect(restarted.evaluateToolCall(call).decision).toBe('approved_once');
  expect(restarted.evaluateToolCall(call).decision).toBe('required');
  expect(fs.existsSync(path.join(dir, 'workspace.json'))).toBe(false);
  expect(worker(dir).handleApprovalResponse(reply)).toBeNull();
});

test('failed durable consumption cannot grant replay or durable trust', () => {
  const dir = makeDir();
  const runtime = worker(dir);
  const request = runtime.evaluateToolCall(call);
  const file = path.join(dir, 'pending.json');
  const before = fs.readFileSync(file, 'utf8');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('write failed');
  });
  expect(() =>
    runtime.resolveApprovalResponse({
      kind: 'approve',
      requestId: request.requestId!,
      mode: 'all',
    }),
  ).toThrow('write failed');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(runtime.evaluateToolCall(call).decision).toBe('required');
  expect(fs.existsSync(path.join(dir, 'workspace.json'))).toBe(false);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});
