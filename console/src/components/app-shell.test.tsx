import { describe, expect, it } from 'vitest';
import { resolveCurrentAdminNavItem } from './admin-nav';

describe('resolveCurrentAdminNavItem', () => {
  it('resolves a nav item by exact path', () => {
    expect(resolveCurrentAdminNavItem('/admin/approvals')).toMatchObject({
      to: '/admin/approvals',
      label: 'Approvals',
    });
  });

  it('resolves top-level app paths outside the sidebar groups', () => {
    expect(resolveCurrentAdminNavItem('/agents')).toMatchObject({
      to: '/agents',
      label: 'Agents',
    });
  });

  it('resolves skill detail routes to the singular page title', () => {
    expect(resolveCurrentAdminNavItem('/admin/skills/blink')).toMatchObject({
      to: '/admin/skills',
      label: 'Skill',
    });
  });

  it('resolves Teams setup to the app setup page title', () => {
    expect(resolveCurrentAdminNavItem('/admin/teams')).toMatchObject({
      to: '/admin/teams',
      label: 'App Setup',
    });
  });

  it('falls back to the first nav item when no match is found', () => {
    expect(resolveCurrentAdminNavItem('/admin/unknown')).toMatchObject({
      to: '/admin',
    });
  });
});
