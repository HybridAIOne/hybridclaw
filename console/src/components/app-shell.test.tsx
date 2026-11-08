import { describe, expect, it } from 'vitest';
import { resolveCurrentAdminNavItem } from './admin-nav';

describe('resolveCurrentAdminNavItem', () => {
  it.each([
    ['/admin/security', 'Approvals & firewall'],
    ['/admin/network-policy', 'Network Policy'],
    ['/admin/safety-rules', 'Safety blocks'],
  ])('resolves the security page title for %s', (to, label) => {
    expect(resolveCurrentAdminNavItem(to)).toMatchObject({
      to,
      label,
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

  it('uses the merged Agents label', () => {
    expect(resolveCurrentAdminNavItem('/admin/agents')).toMatchObject({
      label: 'Agents',
    });
  });

  it('falls back to the first nav item when no match is found', () => {
    expect(resolveCurrentAdminNavItem('/admin/unknown')).toMatchObject({
      to: '/admin',
    });
  });
});
