import { beforeEach, expect, test, vi } from 'vitest';
import type { PendingApprovalPrompt } from '../src/gateway/pending-approvals.js';

const mocks = vi.hoisted(() => ({
  pending: null as PendingApprovalPrompt | null,
  gatewayMessage: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../src/gateway/pending-approvals.js', () => ({
  getPendingApproval: (sessionId: string) => sessionId === 'session-a' ? mocks.pending : null,
  cleanupExpiredPendingApprovals: vi.fn(),
  clearPendingApproval: mocks.clear,
  rememberPendingApproval: vi.fn(),
}));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({ handleGatewayMessage: mocks.gatewayMessage }));
vi.mock('../src/gateway/gateway-service.js', () => ({ handleGatewayCommand: vi.fn(), renderGatewayCommand: vi.fn() }));
vi.mock('../src/memory/memory-service.js', () => ({ memoryService: { getSessionById: () => null } }));

import { resolveImplicitNumericApprovalArgs } from '../src/gateway/channel-message.js';
import { handleTextChannelApprovalCommand } from '../src/gateway/text-channel-commands.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = {
    approvalId: 'approval_a',
    prompt: 'Full review: cp scripts/report.js scripts/report-v2.js',
    userId: 'user-a',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
});

test('zero opens the stored full review without granting consent or executing a command', async () => {
  const args = resolveImplicitNumericApprovalArgs({ sessionId: 'session-a', userId: 'user-a', content: '0' });
  expect(args).toEqual(['approve', 'view']);
  const result = await handleTextChannelApprovalCommand({
    sessionId: 'session-a', guildId: null, channelId: 'msteams', userId: 'user-a', username: 'Example', args: args!,
  });
  expect(result?.text).toContain(mocks.pending?.prompt);
  expect(mocks.gatewayMessage).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.pending?.approvalId).toBe('approval_a');
});

test.each([
  ['session-a', 'user-b'],
  ['another-session', 'user-a'],
])('details shortcut cannot cross ownership or session boundaries: %s / %s', async (sessionId, userId) => {
  expect(resolveImplicitNumericApprovalArgs({ sessionId, userId, content: '0' })).toBeNull();
  const result = await handleTextChannelApprovalCommand({ sessionId, guildId: null, channelId: 'msteams', userId, username: 'Example', args: ['approve', 'view'] });
  expect(result?.text).not.toContain(mocks.pending?.prompt);
  expect(mocks.gatewayMessage).not.toHaveBeenCalled();
});

test('zero remains ordinary input when there is no pending approval', () => {
  mocks.pending = null;
  expect(resolveImplicitNumericApprovalArgs({ sessionId: 'session-a', userId: 'user-a', content: '0' })).toBeNull();
});
