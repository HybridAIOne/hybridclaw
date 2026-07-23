import { describe, expect, it } from 'vitest';
import { Network, Share } from '../icons';
import { ADMIN_CONFIG_SECTION_OWNERS, SIDEBAR_NAV_GROUPS } from './navigation';

describe('SIDEBAR_NAV_GROUPS', () => {
  it('uses the merged Phase 3 information architecture', () => {
    expect(
      SIDEBAR_NAV_GROUPS.map((group) => ({
        label: group.label,
        ...(group.defaultCollapsed === undefined
          ? {}
          : { defaultCollapsed: group.defaultCollapsed }),
        items: group.items.map(({ to, label }) => ({ to, label })),
      })),
    ).toEqual([
      {
        label: 'Overview',
        items: [
          { to: '/admin', label: 'Dashboard' },
          { to: '/admin/activity', label: 'Activity' },
        ],
      },
      {
        label: 'Agents',
        items: [
          { to: '/admin/agents', label: 'Agents' },
          { to: '/admin/skills', label: 'Skills' },
          { to: '/admin/automation', label: 'Jobs' },
        ],
      },
      {
        label: 'Connectivity',
        items: [
          { to: '/admin/channels', label: 'Channels' },
          { to: '/admin/connectors', label: 'Connectors' },
          { to: '/admin/mcp', label: 'MCP Servers' },
          { to: '/admin/federation', label: 'Agent2Agent' },
        ],
      },
      {
        label: 'Models',
        items: [{ to: '/admin/models', label: 'Providers' }],
      },
      {
        label: 'Security',
        items: [
          { to: '/admin/network-policy', label: 'Network Policy' },
          { to: '/admin/output-guard', label: 'Output Guard' },
          { to: '/admin/credentials', label: 'Credentials' },
        ],
      },
      {
        label: 'System',
        items: [
          { to: '/admin/gateway', label: 'Gateway' },
          { to: '/admin/config', label: 'Settings' },
          { to: '/admin/logs', label: 'Logs' },
          { to: '/admin/extensions', label: 'Plugins & Tools' },
          { to: '/admin/terminal', label: 'Terminal' },
        ],
      },
      {
        label: 'Labs',
        defaultCollapsed: true,
        items: [
          { to: '/admin/harness-evolution', label: 'Harness Evolution' },
          { to: '/admin/distill', label: 'Distill' },
        ],
      },
    ]);
  });

  it('does not expose the same route from more than one sidebar item', () => {
    const routes = SIDEBAR_NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => item.to),
    );

    expect(new Set(routes).size).toBe(routes.length);
    expect(
      SIDEBAR_NAV_GROUPS.filter((group) => group.label !== 'Labs').flatMap(
        (group) => group.items,
      ),
    ).toHaveLength(18);
  });

  it('uses network-oriented icons for network policy and Agent2Agent', () => {
    const items = SIDEBAR_NAV_GROUPS.flatMap((group) => group.items);

    expect(
      items.find((item) => item.to === '/admin/network-policy')?.icon,
    ).toBe(Network);
    expect(items.find((item) => item.to === '/admin/federation')?.icon).toBe(
      Share,
    );
  });

  it('keeps JSON section ownership next to the canonical navigation map', () => {
    expect(ADMIN_CONFIG_SECTION_OWNERS.discord).toEqual({
      label: 'Channels',
      to: '/admin/channels#discord',
    });
    expect(ADMIN_CONFIG_SECTION_OWNERS.msteams).toEqual({
      label: 'Channels',
      to: '/admin/channels#teams',
    });
    expect(ADMIN_CONFIG_SECTION_OWNERS.mcpServers).toEqual({
      label: 'MCP Servers',
      to: '/admin/mcp',
    });
    expect(ADMIN_CONFIG_SECTION_OWNERS.scheduler).toEqual({
      label: 'Jobs',
      to: '/admin/automation?tab=schedules',
    });
  });
});
