import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const temporary = useTempDir('approval-replay-context-');
const request = `Review the settings.\n\n${'Background information.\n'.repeat(90)}\nKeep report.md unchanged.`;
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
  runtime.setApprovalMode({ mode: 'auto' });
  return runtime;
}
const read = {
  toolName: 'read',
  argsJson: JSON.stringify({ path: '.env' }),
  latestUserPrompt: request,
};

test('a restarted worker keeps the complete original request on approval replay', () => {
  const dir = temporary();
  const pending = worker(dir).evaluateToolCall(read);
  const runtime = worker(dir);
  expect(runtime.getPendingApprovals()[0]?.originalPrompt).toBe(request);
  const result = runtime.resolveApprovalResponse({
    kind: 'approve',
    requestId: pending.requestId!,
    mode: 'once',
  });
  expect(result?.replayPrompt).toContain(request);
  expect(result?.approvedToolCall).toEqual({
    toolName: read.toolName,
    argsJson: read.argsJson,
  });
  expect(runtime.evaluateToolCall(read).decision).toBe('approved_once');
  expect(runtime.evaluateToolCall(read).decision).toBe('required');
});

test('keeping a long email as a draft preserves proposed data, user changes and original constraints', () => {
  const dir = temporary();
  const runtime = worker(dir);
  const argsJson = JSON.stringify({
    action: 'send',
    channelId: 'pat@example.com',
    subject: 'Project update',
    content: `${'Synthetic project detail.\n'.repeat(100)}End of proposed body.`,
  });
  const call = { toolName: 'message', argsJson, latestUserPrompt: request };
  const pending = runtime.evaluateToolCall(call);
  expect(pending.decision).toBe('required');
  const email = {
    subject: 'Draft update',
    body: `${'Revised project detail.\n'.repeat(100)}End of revised body.`,
  };
  const result = worker(dir).resolveApprovalResponse({
    kind: 'draft',
    requestId: pending.requestId!,
    email,
  });
  expect(result?.replayPrompt).toContain(argsJson);
  expect(result?.replayPrompt).toContain(JSON.stringify(email));
  expect(result?.replayPrompt).toContain(request);
  expect(result?.approvedToolCall).toBeUndefined();
  expect(worker(dir).getPendingApprovals()).toEqual([]);
  expect(worker(dir).evaluateToolCall(call).decision).toBe('required');
});

test.each([
  { session: 'different-session', user: 'user-a' },
  { session: 'session-a', user: 'different-user' },
])(
  'full request replay remains bound to its session and user: %j',
  ({ session, user }) => {
    const dir = temporary();
    const pending = worker(dir).evaluateToolCall(read);
    const result = worker(dir, session, user).resolveApprovalResponse({
      kind: 'approve',
      requestId: pending.requestId!,
    });
    expect(result?.replayPrompt).toBeUndefined();
    expect(result?.approvedToolCall).toBeUndefined();
    expect(worker(dir).getPendingApprovals()).toHaveLength(1);
  },
);
