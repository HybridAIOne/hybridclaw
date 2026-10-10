import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GatewayChatRequest, GatewayChatResult } from '../src/gateway/gateway-types.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hy-chat-approval-');
beforeEach(() => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', makeTempDir());
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const request: GatewayChatRequest = { sessionId: 'mail-session', channelId: 'web', userId: 'pat', username: 'pat', guildId: null, content: 'Send the reviewed draft.' };
const approval = { approvalId: 'mail-1', prompt: 'Send email?', intent: 'send email', reason: 'external communication', toolName: 'mcp__mail__send_mail', reviewArguments: JSON.stringify({ from: 'pat@example.com', to: ['lee@example.com'], body: 'See you then.\n'.repeat(200), attachments: [{ path: '/workspace/agenda.pdf' }] }), allowSession: false, allowAgent: true, allowAll: false, expiresAt: Date.now() + 60_000, rule: { category: 'send_messages' as const, actionKey: 'message:email', label: 'send email', pausedBy: 'ask_mode' as const } };
const result: GatewayChatResult = { status: 'success', result: 'Please review.', toolsUsed: [], pendingApproval: approval };

test('restores complete approval facts after restart only for the owner', async () => {
  const { rememberChatApproval } = await import('../src/gateway/chat-approval-review.js');
  await rememberChatApproval(request, result);
  vi.resetModules();
  const { pendingChatApproval } = await import('../src/gateway/chat-approval-review.js');
  expect(pendingChatApproval('mail-session', 'pat')).toEqual({ ...approval, type: 'approval' });
  expect(pendingChatApproval('mail-session', 'lee')).toBeNull();
  expect(pendingChatApproval('other-session', 'pat')).toBeNull();
  const { clearPendingApproval } = await import('../src/gateway/pending-approvals.js');
  await clearPendingApproval('mail-session');
  expect(pendingChatApproval('mail-session', 'pat')).toBeNull();
});

test('does not restore expired, claimed or externally escalated reviews', async () => {
  const { rememberChatApproval, pendingChatApproval } = await import('../src/gateway/chat-approval-review.js');
  await rememberChatApproval(request, { ...result, pendingApproval: { ...approval, expiresAt: Date.now() - 1 } });
  expect(pendingChatApproval('mail-session', 'pat')).toBeNull();
  const { clearPendingApproval, claimPendingApprovalByApprovalId } = await import('../src/gateway/pending-approvals.js');
  await clearPendingApproval('mail-session');
  await rememberChatApproval(request, result);
  claimPendingApprovalByApprovalId({ approvalId: approval.approvalId, userId: 'pat' });
  expect(pendingChatApproval('mail-session', 'pat')).toBeNull();
  await clearPendingApproval('mail-session');
  await rememberChatApproval(request, { ...result, pendingApproval: { ...approval, escalationTarget: { channel: 'discord', recipient: 'reviewer' } } });
  expect(pendingChatApproval('mail-session', 'pat')).toBeNull();
});
