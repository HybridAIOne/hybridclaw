import { describe, expect, it } from 'vitest';
import { resolveCurrentAdminNavItem } from './admin-nav';

describe('resolveCurrentAdminNavItem', () => {
  const visibleNavItems = [
    { to: '/', label: 'Dashboard' },
    { to: '/approvals', label: 'Approvals' },
  ] as const;

  it('keeps the chat title for the hidden admin chat route', () => {
    expect(resolveCurrentAdminNavItem('/chat', visibleNavItems)).toEqual({
      to: '/chat',
      label: 'Chat',
    });
  });

  it('prefers visible sidebar items when present', () => {
    expect(resolveCurrentAdminNavItem('/approvals', visibleNavItems)).toEqual({
      to: '/approvals',
      label: 'Approvals',
    });
  });
});
