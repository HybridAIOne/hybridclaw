import { expect, test } from 'vitest';

import { selectTuiInteractiveReplySession } from '../src/tui.js';
import type { GatewayAdminSuspendedSession } from '../src/gateway/gateway-types.js';

function session(
  input: Partial<GatewayAdminSuspendedSession>,
): GatewayAdminSuspendedSession {
  return {
    sessionId: input.sessionId || 'suspended-1',
    agentId: input.agentId ?? 'main',
    approvalId: input.approvalId || 'approval-1',
    userId: input.userId ?? 'operator',
    prompt: input.prompt || 'A totp challenge needs operator input.',
    status: input.status || 'pending',
    modality: input.modality || 'totp',
    expectedReturnKinds: input.expectedReturnKinds || [
      'code',
      'declined',
      'timeout',
    ],
    context: input.context || {},
    createdAt: input.createdAt || '2026-05-25T12:00:00.000Z',
    expiresAt: input.expiresAt || '2026-05-25T12:10:00.000Z',
    blockedLabel: input.blockedLabel || 'blocked: needs 2FA',
  };
}

test('TUI routes bare operator codes to browser-created 2FA sessions', () => {
  expect(
    selectTuiInteractiveReplySession([
      session({
        sessionId: 'older',
        userId: 'operator',
        createdAt: '2026-05-25T12:00:00.000Z',
      }),
      session({
        sessionId: 'latest',
        userId: 'operator',
        createdAt: '2026-05-25T12:13:42.650Z',
      }),
    ])?.sessionId,
  ).toBe('latest');
});

test('TUI does not steal explicit non-TUI operator sessions', () => {
  expect(
    selectTuiInteractiveReplySession([
      session({
        sessionId: 'sms-user-session',
        userId: '+491701234567',
      }),
    ]),
  ).toBeNull();
});
