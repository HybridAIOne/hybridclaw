import { describe, expect, it } from 'vitest';
import { ADMIN_CONFIG_SECTION_OWNERS, SIDEBAR_NAV_GROUPS } from './navigation';

describe('SIDEBAR_NAV_GROUPS', () => {
  it('uses the task-oriented Phase 1 information architecture', () => {
    expect(
      SIDEBAR_NAV_GROUPS.map((group) => ({
        label: group.label,
        items: group.items.map(({ to, label }) => ({ to, label })),
      })),
    ).toEqual([
      {
        label: 'Overview',
        items: [
          { to: '/admin', label: 'Dashboard' },
          { to: '/admin/statistics', label: 'Statistics' },
          { to: '/admin/sessions', label: 'Sessions' },
          { to: '/admin/audit', label: 'Audit Log' },
        ],
      },
      {
        label: 'Agents',
        items: [
          { to: '/admin/agent-scoreboard', label: 'Agent Scoreboard' },
          { to: '/admin/agents', label: 'Workspace Files' },
          { to: '/admin/skills', label: 'Skills' },
          { to: '/admin/jobs', label: 'Work Queue' },
          { to: '/admin/scheduler', label: 'Schedules' },
        ],
      },
      {
        label: 'Connectivity',
        items: [
          { to: '/admin/channels', label: 'Channels' },
          { to: '/admin/email', label: 'Mailbox' },
          { to: '/admin/connectors', label: 'Connectors' },
          { to: '/admin/mcp', label: 'MCP Servers' },
          { to: '/admin/a2a-inbox', label: 'A2A Inbox' },
          { to: '/admin/a2a-trust', label: 'A2A Trust' },
          { to: '/admin/fleet-topology', label: 'Fleet Topology' },
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
          { to: '/admin/secrets', label: 'Secrets' },
          { to: '/admin/tokens', label: 'API Tokens' },
        ],
      },
      {
        label: 'System',
        items: [
          { to: '/admin/gateway', label: 'Gateway' },
          { to: '/admin/config', label: 'Settings' },
          { to: '/admin/logs', label: 'Logs' },
          { to: '/admin/plugins', label: 'Plugins' },
          { to: '/admin/tools', label: 'Tools' },
          { to: '/admin/terminal', label: 'Terminal' },
        ],
      },
      {
        label: 'Labs',
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
  });

  it('keeps JSON section ownership next to the canonical navigation map', () => {
    expect(ADMIN_CONFIG_SECTION_OWNERS.discord).toEqual({
      label: 'Channels',
      to: '/admin/channels',
    });
    expect(ADMIN_CONFIG_SECTION_OWNERS.mcpServers).toEqual({
      label: 'MCP Servers',
      to: '/admin/mcp',
    });
    expect(ADMIN_CONFIG_SECTION_OWNERS.scheduler).toEqual({
      label: 'Schedules',
      to: '/admin/scheduler',
    });
  });
});
