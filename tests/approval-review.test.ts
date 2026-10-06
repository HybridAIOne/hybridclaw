import { parseApprovalProgress } from '../src/infra/approval-progress.js';
import { expect, test } from 'vitest';
import { approvalReviewArguments } from '../container/src/approval-review.js';
import { extractGatewayChatApprovalEvent } from '../src/gateway/chat-approval.js';

test('preserves a complete message and projects attachment metadata without credentials or bytes', () => {
  const body = `Hello,\n${'Grüße 東京 '.repeat(400)}\nEnd.`;
  const reviewArguments = approvalReviewArguments('hybridai__google__send_mail', JSON.stringify({
    account: 'sender@example.com', to: ['reader@example.com'], body,
    access_token: 'secret-test-value', password: 'secret-password',
    attachments: [{ name: 'offers.pdf', path: '/workspace/offers.pdf', contentBytes: 'secret-binary', size: 123 }],
  }));
  expect(JSON.parse(reviewArguments!)).toEqual({
    account: 'sender@example.com', to: ['reader@example.com'], body,
    attachments: [{ name: 'offers.pdf', path: '/workspace/offers.pdf', size: 123 }],
  });
  const result = extractGatewayChatApprovalEvent({
    status: 'success', result: '', toolsUsed: [], pendingApproval: {
      approvalId: '1a2b3c4d', prompt: 'Review', intent: 'run MCP tool google__send_mail', reason: 'Send',
      commandPreview: '{truncated', reviewArguments,
      allowSession: false, allowAgent: false, allowAll: false, expiresAt: 123,
    },
  });
  expect(result?.reviewArguments).toBe(reviewArguments);
  expect(result?.allowSession).toBe(false);
});

test('nested message and sharing permissions are projected without unrelated fields', () => {
  const value = approvalReviewArguments('microsoft_graph__send_mail', JSON.stringify({
    message: { toRecipients: [{ emailAddress: { address: 'reader@example.com', token: 'secret' } }],
      body: { contentType: 'HTML', content: '<p>Full body</p>', token: 'secret' }, attachments: [] },
    permission: { role: 'reader', emailAddress: 'reader@example.com', token: 'secret' },
  }));
  expect(value).not.toContain('secret');
  expect(JSON.parse(value!).message.body.content).toBe('<p>Full body</p>');
  expect(JSON.parse(value!).message.attachments).toEqual([]);
});

test.each(['not json', '[]', '{}', JSON.stringify({ body: 'x'.repeat(270_000) })])('omits malformed, empty or oversized review without truncating (%#)', (input) => {
  expect(approvalReviewArguments('google__send_mail', input)).toBeUndefined();
});

test('does not project shell inputs or invent a sender or attachments', () => {
  expect(approvalReviewArguments('bash', '{"body":"not mail"}')).toBeUndefined();
  expect(JSON.parse(approvalReviewArguments('google__send_mail', '{"body":"Hello"}')!)).toEqual({ body: 'Hello' });
});

test('IPC keeps complete review metadata and rejects oversized fields without changing grants', () => {
  const payload = { approvalId: '1a2b3c4d', prompt: 'Review', intent: 'send', reason: 'outbound',
    toolName: 'google__send_mail', commandPreview: '{short', reviewArguments: '{"body":"Hello"}',
    allowSession: false, allowAgent: false, allowAll: false, expiresAt: 123 };
  const line = (value: unknown) => `[approval] ${Buffer.from(JSON.stringify(value)).toString('base64')}`;
  expect(parseApprovalProgress(line(payload))).toMatchObject(payload);
  expect(parseApprovalProgress(line({ ...payload, reviewArguments: 'x'.repeat(270_000) }))?.reviewArguments).toBeUndefined();
  expect(parseApprovalProgress(line({ ...payload, reviewArguments: {} }))?.reviewArguments).toBeUndefined();
  expect(parseApprovalProgress(line({}))).toBeNull();
});
