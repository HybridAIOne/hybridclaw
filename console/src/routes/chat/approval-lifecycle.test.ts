import { describe, expect, it } from 'vitest';
import type { ChatStreamApproval } from '../../api/chat-types';
import type { ApprovalAction } from '../../lib/chat-helpers';
import { deriveApprovalStates } from './approval-lifecycle';
import type { ChatUiMessage } from './chat-ui-message';

function structuredApproval(
  overrides: Partial<ChatStreamApproval> = {},
): ChatStreamApproval {
  return {
    type: 'approval',
    approvalId: 'approve-1',
    prompt: 'Trigger a thumbnail snapshot.\nApproval ID: approve-1',
    expiresAt: null,
    ...overrides,
  };
}

function approvalMessage(
  id: string,
  overrides: Partial<ChatUiMessage> = {},
): ChatUiMessage {
  return {
    id,
    role: 'approval',
    content: '',
    sessionId: 'session-a',
    pendingApproval: structuredApproval({ approvalId: id }),
    ...overrides,
  } as ChatUiMessage;
}

function textAnnouncementMessage(
  id: string,
  approvalId: string,
  role: 'assistant' | 'command' = 'assistant',
): ChatUiMessage {
  return {
    id,
    role,
    content: [
      'Approval needed for: trigger a thumbnail snapshot',
      `Approval ID: ${approvalId}`,
      'Reply `yes` to approve once.',
    ].join('\n'),
    sessionId: 'session-a',
  } as ChatUiMessage;
}

const NO_RESOLUTIONS: ReadonlyMap<string, ApprovalAction> = new Map();

describe('deriveApprovalStates', () => {
  it('marks the newest approval item active when nothing has been resolved', () => {
    const messages = [
      approvalMessage('m1', {
        pendingApproval: structuredApproval({ approvalId: 'a1' }),
      }),
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'active',
    });
  });

  it('supersedes an older approval once a newer one arrives', () => {
    const messages = [
      approvalMessage('m1', {
        pendingApproval: structuredApproval({ approvalId: 'a1' }),
      }),
      approvalMessage('m2', {
        pendingApproval: structuredApproval({ approvalId: 'a2' }),
      }),
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'superseded',
    });
    expect(states.get('m2')).toMatchObject({
      approvalId: 'a2',
      status: 'active',
    });
  });

  it('marks an approval responded once its id is in resolvedApprovals, even if newest', () => {
    const messages = [
      approvalMessage('m1', {
        pendingApproval: structuredApproval({ approvalId: 'a1' }),
      }),
    ];
    const resolved = new Map<string, ApprovalAction>([['a1', 'session']]);
    const states = deriveApprovalStates(messages, resolved, Date.now());
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'responded',
      respondedAction: 'session',
    });
  });

  it('responded takes priority over superseded for an older, acted-on item', () => {
    const messages = [
      approvalMessage('m1', {
        pendingApproval: structuredApproval({ approvalId: 'a1' }),
      }),
      approvalMessage('m2', {
        pendingApproval: structuredApproval({ approvalId: 'a2' }),
      }),
    ];
    const resolved = new Map<string, ApprovalAction>([['a1', 'deny']]);
    const states = deriveApprovalStates(messages, resolved, Date.now());
    expect(states.get('m1')).toMatchObject({
      status: 'responded',
      respondedAction: 'deny',
    });
    expect(states.get('m2')).toMatchObject({ status: 'active' });
  });

  it('expires a structured approval once its expiresAt is in the past', () => {
    const now = Date.now();
    const messages = [
      approvalMessage('m1', {
        pendingApproval: structuredApproval({
          approvalId: 'a1',
          expiresAt: now - 1000,
        }),
      }),
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, now);
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'expired',
    });
  });

  it('keeps older items superseded even when the newest one expired', () => {
    // Each new request replaces the previous pending one on the gateway, so
    // an older item must never become actionable again.
    const now = Date.now();
    const messages = [
      approvalMessage('m1', {
        pendingApproval: structuredApproval({ approvalId: 'a1' }),
      }),
      approvalMessage('m2', {
        pendingApproval: structuredApproval({
          approvalId: 'a2',
          expiresAt: now - 1000,
        }),
      }),
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, now);
    expect(states.get('m2')).toMatchObject({ status: 'expired' });
    expect(states.get('m1')).toMatchObject({ status: 'superseded' });
  });

  it('treats a payloadless approval-role message as a text item using its content', () => {
    const messages = [
      {
        id: 'm1',
        role: 'approval',
        content: 'Approval needed for: run a scan\nApproval ID: a1',
        sessionId: 'session-a',
        pendingApproval: null,
      } as ChatUiMessage,
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'active',
    });
  });

  it('treats an assistant text announcement as an approval item', () => {
    const messages = [textAnnouncementMessage('m1', 'a1', 'assistant')];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'active',
    });
  });

  it('treats a command text announcement (e.g. **Pending Approval**) as an approval item', () => {
    const messages: ChatUiMessage[] = [
      {
        id: 'm1',
        role: 'command',
        content: '**Pending Approval**\nRun a scan.\nApproval ID: a1',
        sessionId: 'session-a',
      } as ChatUiMessage,
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.get('m1')).toMatchObject({
      approvalId: 'a1',
      status: 'active',
    });
  });

  it('ignores plain assistant text that is not an approval announcement', () => {
    const messages: ChatUiMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Just a normal reply.',
        sessionId: 'session-a',
      } as ChatUiMessage,
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.size).toBe(0);
  });

  it('a text announcement can be superseded by a later structured approval', () => {
    const messages = [
      textAnnouncementMessage('m1', 'a1'),
      approvalMessage('m2', {
        pendingApproval: structuredApproval({ approvalId: 'a2' }),
      }),
    ];
    const states = deriveApprovalStates(messages, NO_RESOLUTIONS, Date.now());
    expect(states.get('m1')).toMatchObject({ status: 'superseded' });
    expect(states.get('m2')).toMatchObject({ status: 'active' });
  });
});
