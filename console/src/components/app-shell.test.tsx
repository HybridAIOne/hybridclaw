import { describe, expect, it } from 'vitest';
import { resolveCurrentAdminNavItem } from './admin-nav';

describe('resolveCurrentAdminNavItem', () => {
  const visibleNavItems = [
    { to: '/admin', label: 'Dashboard' },
    { to: '/admin/approvals', label: 'Approvals' },
  ] as const;

  it('resolves a visible sidebar item by exact path', () => {
    expect(
      resolveCurrentAdminNavItem('/admin/approvals', visibleNavItems),
    ).toEqual({
      to: '/admin/approvals',
      label: 'Approvals',
    });
  });

  it('falls back to the first nav item when no match is found', () => {
    expect(
      resolveCurrentAdminNavItem('/admin/unknown', visibleNavItems),
    ).toEqual({
      to: '/admin',
      label: 'Dashboard',
    });
  });
});
