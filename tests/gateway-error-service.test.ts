import { describe, expect, test } from 'vitest';

import { WhatsAppAuthLockError } from '../src/channels/whatsapp/auth.js';
import {
  formatAgentErrorReply,
  formatChannelGatewayErrorReply,
  formatGatewayErrorReply,
  isDefaultChannelInterruptedReply,
  isDiscordInvalidTokenError,
  isWhatsAppAuthLockError,
} from '../src/gateway/gateway-error-service.js';

describe('gateway error service', () => {
  test('formats gateway and agent errors for text channels', () => {
    expect(formatGatewayErrorReply(new Error('database unavailable'))).toBe(
      '**Gateway Error:** database unavailable',
    );
    expect(formatAgentErrorReply('tool failed')).toBe(
      '**Agent Error:** tool failed',
    );
    expect(formatAgentErrorReply(null)).toBe('**Agent Error:** Unknown error');
  });

  test('formats channel gateway failures using existing transient rules', () => {
    const interrupted = formatChannelGatewayErrorReply(
      'timeout waiting for agent output',
    );

    expect(isDefaultChannelInterruptedReply(interrupted)).toBe(true);
    expect(formatChannelGatewayErrorReply(new Error('Permission denied'))).toBe(
      '**Agent Error:** Permission denied',
    );
  });

  test('classifies startup errors used by gateway integrations', () => {
    expect(isDiscordInvalidTokenError({ code: 'TokenInvalid' })).toBe(true);
    expect(
      isDiscordInvalidTokenError(new Error('Discord rejected invalid token')),
    ).toBe(true);
    expect(isDiscordInvalidTokenError(new Error('network failed'))).toBe(false);

    const lockError = new WhatsAppAuthLockError('locked', {
      lockPath: '/tmp/whatsapp.lock',
      ownerPid: 123,
    });
    expect(isWhatsAppAuthLockError(lockError)).toBe(true);
    expect(isWhatsAppAuthLockError(new Error('locked'))).toBe(false);
  });
});
