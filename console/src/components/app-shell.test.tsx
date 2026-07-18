import { describe, expect, it } from 'vitest';
import { resolveCurrentAdminNavItem } from './admin-nav';

describe('resolveCurrentAdminNavItem', () => {
  it('resolves a nav item by exact path', () => {
    expect(resolveCurrentAdminNavItem('/admin/network-policy')).toMatchObject({
      to: '/admin/network-policy',
      label: 'Network Policy',
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

  it('uses distinct labels for the agent admin surfaces', () => {
    expect(resolveCurrentAdminNavItem('/admin/agents')).toMatchObject({
      label: 'Workspace Files',
    });
    expect(resolveCurrentAdminNavItem('/admin/agent-scoreboard')).toMatchObject(
      {
        label: 'Agent Scoreboard',
      },
    );
  });

  it('falls back to the first nav item when no match is found', () => {
    expect(resolveCurrentAdminNavItem('/admin/unknown')).toMatchObject({
      to: '/admin',
    });
  });
});
