import { expect, test, vi } from 'vitest';
const audit = vi.hoisted(() => vi.fn());
vi.mock('../src/audit/audit-events.js', () => ({ recordAuditEvent: audit }));
import {
  approvalReplyContext,
  recordApprovalReply,
} from '../src/gateway/chat-approval.js';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
const request: GatewayChatRequest = {
  sessionId: 'session-a',
  guildId: null,
  channelId: 'web',
  userId: 'user-a',
  username: 'Pat',
  content: 'model-generated task prompt',
};

test('text consent uses raw inbound text and gateway identity', () => {
  expect(approvalReplyContext(request, 'Raw user message')).toEqual({
    approvalUserText: 'Raw user message',
    approvalUserId: 'user-a',
  });
});

test('voice consent uses the transcript independently of generated task text', () => {
  expect(
    approvalReplyContext(
      {
        ...request,
        approvalUserText: 'Bitte senden.',
        approvalUserId: 'not-the-caller',
      },
      'generated request',
    ),
  ).toEqual({ approvalUserText: 'Bitte senden.', approvalUserId: 'user-a' });
});

test.each(['fullauto', 'heartbeat', 'goal-continuation', 'scheduler'])(
  'autonomous source %s cannot provide consent',
  (source) => {
    expect(
      approvalReplyContext(
        { ...request, source, approvalUserText: 'yes' },
        'yes',
      ).approvalUserText,
    ).toBeNull();
  },
);

test('missing speech stays absent rather than using a generated confirmation', () => {
  expect(
    approvalReplyContext({ ...request, approvalUserText: null }, 'yes')
      .approvalUserText,
  ).toBeNull();
});

test('audit associates the interpretation with the same session and turn as raw input', () => {
  const interpretation = {
    decision: 'approve' as const,
    approvalId: 'abcdef12',
    scope: 'once' as const,
    model: 'test-model',
  };
  recordApprovalReply('session-a', 'turn-a', {
    status: 'success',
    result: 'done',
    toolsUsed: [],
    approvalReply: interpretation,
  });
  expect(audit).toHaveBeenLastCalledWith({
    sessionId: 'session-a',
    runId: 'turn-a',
    event: { type: 'approval.interpretation', ...interpretation },
  });
});

test.each([
  undefined,
  'fullauto',
  'heartbeat',
  'goal-continuation',
  'scheduler',
])(
  'structured denial can cancel without captured human speech: %s',
  (source) => {
    expect(
      approvalReplyContext(
        {
          ...request,
          source,
          approvalUserText: null,
          approval: { approvalId: 'abcdef12', decision: 'no' },
        },
        'untrusted generated text',
      ).approvalUserText,
    ).toBe('no abcdef12');
  },
);

test.each(['yes', 'session', 'agent', 'all', 'draft'] as const)(
  'structured %s cannot manufacture missing human consent',
  (decision) => {
    expect(
      approvalReplyContext(
        {
          ...request,
          approvalUserText: null,
          approval: { approvalId: 'abcdef12', decision },
        },
        'generated request',
      ).approvalUserText,
    ).toBeNull();
  },
);
