import { describe, expect, it } from 'vitest';
import { resolveCurrentAdminNavItem } from './admin-nav';

describe('resolveCurrentAdminNavItem', () => {
  it('resolves a nav item by exact path', () => {
    expect(resolveCurrentAdminNavItem('/admin/approvals')).toMatchObject({
      to: '/admin/approvals',
      label: 'Approvals',
    });
  });

  it('falls back to the first nav item when no match is found', () => {
    expect(resolveCurrentAdminNavItem('/admin/unknown')).toMatchObject({
      to: '/admin',
    });
  });
});
