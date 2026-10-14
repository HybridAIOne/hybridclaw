import { beforeEach, expect, test, vi } from 'vitest';
import { resolveConnectorApprovalReply, rememberConnectorApproval } from '../src/gateway/connector-approval-reply.js';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
import { useCleanMocks } from './test-utils.js';
const mocks = vi.hoisted(() => ({ model: vi.fn(), forward: vi.fn(), get: vi.fn(), set: vi.fn(), usage: vi.fn() }));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.model }));
vi.mock('../src/gateway/connector-approval.js', () => ({ forwardConnectorDecision: mocks.forward }));
vi.mock('../src/gateway/pending-approvals.js', () => ({ getPendingApproval: mocks.get, setPendingApproval: mocks.set }));
vi.mock('../src/usage/token-usage-buffer.js', () => ({ enqueueTokenUsage: mocks.usage }));
useCleanMocks();
const id = 'cc-0123456789abcdef';
const req: GatewayChatRequest = { sessionId: 'chat', userId: 'person', username: 'Pat', guildId: null, channelId: 'web', content: 'generated task', approvalUserText: 'Bitte senden.' };
const card = { approvalId: id, toolName: 'mail__send', reviewArguments: '{"to":"pat@example.com"}', prompt: 'Send the draft?', reason: 'Sends mail', intent: 'Send draft', allowSession: false, allowAgent: false, allowAll: false, expiresAt: Date.now() + 60_000 };
const resolve = (request = req) => resolveConnectorApprovalReply(request, [{ role: 'assistant', content: card.prompt }], 'model', 'hy', 'run');
function result(decision = 'approve', scope: string | null = 'once') { return { content: JSON.stringify({ decision, approvalId: id, scope, reply: decision === 'deny' ? 'Bleibt ungesendet.' : '' }), model: 'judge', usage: { inputTokens: 12, outputTokens: 3 } }; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ approvalId: id, approval: card, userId: 'person', expiresAt: Date.now() + 60_000 });
  mocks.model.mockResolvedValue(result());
  mocks.forward.mockResolvedValue(undefined);
});
test('raw speech is interpreted at the host and a one-shot decision reaches the existing broker boundary', async () => {
  expect(await resolve()).toMatchObject({ decision: 'approve', approvalId: id, scope: 'once', model: 'judge' });
  expect(JSON.parse(mocks.model.mock.calls[0][0].messages[1].content).userReply).toBe(req.approvalUserText);
  expect(mocks.forward).toHaveBeenCalledWith({ approvalId: id, decision: 'yes' }, 'chat', 'person');
  expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ auditRunId: 'run', inputTokens: 12, outputTokens: 3 }));
});
test.each(['deny', 'revise'])('%s rejects the old broker proposal without authorizing changed arguments', async decision => {
  mocks.model.mockResolvedValue(result(decision, null));
  expect((await resolve())?.decision).toBe(decision);
  expect(mocks.forward).toHaveBeenCalledWith({ approvalId: id, decision: 'no' }, 'chat', 'person');
});
test.each([
  { approvalUserText: null }, { source: 'heartbeat' }, { source: 'scheduler' },
  { userId: 'another-person' }, { approval: { approvalId: id, decision: 'yes' as const } },
])('does not reinterpret absent speech, autonomous turns, other users or already handled buttons: %j', async overrides => {
  expect(await resolve({ ...req, ...overrides })).toBeUndefined();
  expect(mocks.model).not.toHaveBeenCalled();
  expect(mocks.forward).not.toHaveBeenCalled();
});
test.each(['all', 'session'])('a broker request never accepts %s scope', async scope => {
  mocks.model.mockResolvedValue(result('approve', scope));
  expect((await resolve())?.decision).toBe('error');
  expect(mocks.forward).not.toHaveBeenCalled();
});
test('broker rejection or expiry during interpretation cannot authorize the worker', async () => {
  mocks.forward.mockRejectedValue(new Error('no longer pending'));
  expect((await resolve())?.decision).toBe('error');
});
test('invalid model output cannot authorize or escape accounting', async () => {
  mocks.model.mockResolvedValue({ ...result(), content: '{}' });
  expect((await resolve())?.decision).toBe('error');
  expect(mocks.forward).not.toHaveBeenCalled();
  expect(mocks.usage).toHaveBeenCalledTimes(1);
});
test('phone and browser voice retain broker prompts for the next spoken answer', async () => {
  mocks.get.mockReturnValue(null);
  await rememberConnectorApproval({ ...req, channelId: 'phone' }, { status: 'success', result: card.prompt, toolsUsed: [], pendingApproval: card });
  expect(mocks.set).toHaveBeenCalledWith('chat', expect.objectContaining({ userId: 'person', approval: card }));
});

test('an interrupted turn cannot forward consent after the model returns', async () => {
  const controller = new AbortController();
  mocks.model.mockImplementationOnce(async () => { controller.abort(); return result(); });
  expect((await resolveConnectorApprovalReply(req, [], 'model', 'hy', 'run', controller.signal))?.decision).toBe('error');
  expect(mocks.forward).not.toHaveBeenCalled();
});
