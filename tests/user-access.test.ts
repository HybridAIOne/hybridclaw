import { describe, expect, test } from 'vitest';
import {
  isUserApiRouteAllowed,
  isUserChatContentAllowed,
  isUserCommandAllowed,
} from '../src/security/user-access.js';

describe('grant-scoped user access', () => {
  test('allows only the web-chat API surface', () => {
    expect(isUserApiRouteAllowed('/api/chat', 'POST')).toBe(true);
    expect(isUserApiRouteAllowed('/api/history', 'GET')).toBe(true);
    expect(isUserApiRouteAllowed('/api/agents/list', 'GET')).toBe(true);
    expect(isUserApiRouteAllowed('/api/agents', 'GET')).toBe(false);
    expect(isUserApiRouteAllowed('/api/admin/overview', 'GET')).toBe(false);
    expect(isUserApiRouteAllowed('/api/apps', 'GET')).toBe(false);
    expect(isUserApiRouteAllowed('/v1/models', 'GET')).toBe(false);
  });

  test('allows help and session-bounded approval commands', () => {
    expect(isUserCommandAllowed(['help'])).toBe(true);
    expect(isUserCommandAllowed(['approve', 'yes', 'approval-1'])).toBe(true);
    expect(isUserCommandAllowed(['approve', 'session', 'approval-1'])).toBe(
      true,
    );
    expect(isUserCommandAllowed(['approve', 'agent', 'approval-1'])).toBe(
      false,
    );
    expect(isUserCommandAllowed(['agent', 'switch', 'other'])).toBe(false);
  });

  test('rejects slash-command chaining and durable approval aliases', () => {
    expect(isUserChatContentAllowed('Please reconcile these invoices.')).toBe(
      true,
    );
    expect(isUserChatContentAllowed('/help')).toBe(true);
    expect(isUserChatContentAllowed('/approve yes approval-1')).toBe(true);
    expect(isUserChatContentAllowed('/approve all approval-1')).toBe(false);
    expect(isUserChatContentAllowed('/help\n/agent list')).toBe(false);
  });

  test.each([
    'approve agent',
    'approve for agent',
    'approve all',
    'approve for all',
    'yes agent',
    'yes for agent',
    'yes all',
    'yes for all',
    'y agent',
    'y for agent',
    'y all',
    'y for all',
    'approve abcdef agent',
    'yes deadbeef for all',
    'y 123456 agent',
    '<@123456> approve all',
    'Message 2: yes all',
    'Continue with the request.\napprove all',
    '3',
    '4',
  ])('rejects durable approval reply %j', (content) => {
    expect(isUserChatContentAllowed(content)).toBe(false);
  });

  test.each([
    'yes',
    'yes session',
    'yes for session',
    'approve session',
    'approve for session',
    'y session',
    'no',
    'deny',
    'reject',
    'skip',
    'n',
    'Please approve all outstanding invoices.',
    '/approve yes approval-1',
    '/approve session approval-1',
    '/approve no approval-1',
  ])('allows non-durable chat or approval reply %j', (content) => {
    expect(isUserChatContentAllowed(content)).toBe(true);
  });
});
