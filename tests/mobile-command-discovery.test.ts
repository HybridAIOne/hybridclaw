import { describe, expect, test } from 'vitest';
import { DEVICE_TOKEN_ACTIONS, OWNER_DEVICE_TOKEN_ACTIONS } from '../src/gateway/device-grants.js';
import { isAdminActionAllowed, resolveAdminRbacAction } from '../src/security/admin-rbac.js';

describe('phone command discovery', () => {
  test.each([{ actions: DEVICE_TOKEN_ACTIONS }, { actions: OWNER_DEVICE_TOKEN_ACTIONS }])(
    'allows a phone to discover the commands it can send', ({ actions }) => {
      const action = resolveAdminRbacAction('/api/chat/commands', 'GET');
      expect(action).toBe('chat.send');
      expect(isAdminActionAllowed({ actions: [...actions] }, action!)).toBe(true);
    },
  );

  test('does not grant discovery to unrelated capabilities', () => {
    const action = resolveAdminRbacAction('/api/chat/commands', 'GET');
    expect(action).toBe('chat.send');
    expect(isAdminActionAllowed({ actions: ['agents.read'] }, action!)).toBe(false);
    expect(isAdminActionAllowed({ actions: [] }, action!)).toBe(false);
  });

  test.each(['POST', 'PUT', 'DELETE'])('leaves %s unmapped', (method) => {
    expect(resolveAdminRbacAction('/api/chat/commands', method)).toBeNull();
  });

  test('keeps model-backed suggestions and unmapped chat routes closed', () => {
    expect(resolveAdminRbacAction('/api/chat/ideas', 'GET')).toBeNull();
    expect(resolveAdminRbacAction('/api/chat/unknown', 'GET')).toBeNull();
  });
});
