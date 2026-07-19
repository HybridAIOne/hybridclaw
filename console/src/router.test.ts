import { createMemoryHistory } from '@tanstack/react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let router: typeof import('./router')['router'];

describe('legacy admin routes', () => {
  beforeAll(async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    ({ router } = await import('./router'));
    router.update({
      history: createMemoryHistory({ initialEntries: ['/admin'] }),
    });
    await router.load();
  });

  beforeEach(async () => {
    await router.navigate({ to: '/admin' });
  });

  it('redirects Approvals bookmarks to Network Policy', async () => {
    await router.navigate({ to: '/admin/approvals' });

    expect(router.state.location.pathname).toBe('/admin/network-policy');
  });

  it('redirects Teams setup bookmarks to the Connectors subview', async () => {
    await router.navigate({ to: '/admin/teams' });

    expect(router.state.location.pathname).toBe('/admin/connectors');
    expect(router.state.location.hash).toBe('teams-sso');
  });

  it.each([
    ['/admin/statistics', '/admin/activity', 'usage'],
    ['/admin/sessions', '/admin/activity', 'sessions'],
    ['/admin/audit', '/admin/activity', 'audit'],
    ['/admin/jobs', '/admin/automation', 'work-queue'],
    ['/admin/scheduler', '/admin/automation', 'schedules'],
    ['/admin/a2a-trust', '/admin/federation', 'peers'],
    ['/admin/fleet-topology', '/admin/federation', 'topology'],
    ['/admin/a2a-inbox', '/admin/federation', 'inbox'],
    ['/admin/agent-scoreboard', '/admin/agents', 'scoreboard'],
    ['/admin/secrets', '/admin/credentials', 'secrets'],
    ['/admin/tokens', '/admin/credentials', 'api-tokens'],
    ['/admin/plugins', '/admin/extensions', 'plugins'],
    ['/admin/tools', '/admin/extensions', 'tools'],
  ])('redirects %s to its merged tab', async (from, to, tab) => {
    await router.navigate({ to: from });

    expect(router.state.location.pathname).toBe(to);
    expect(router.state.location.search).toMatchObject({ tab });
  });

  it('preserves detail search state through legacy redirects', async () => {
    await router.navigate({
      to: '/admin/scheduler',
      search: { jobId: 'release-notes' },
    });

    expect(router.state.location.pathname).toBe('/admin/automation');
    expect(router.state.location.search).toMatchObject({
      tab: 'schedules',
      jobId: 'release-notes',
    });
  });

  it('retires the standalone agents shell into the admin Agents page', async () => {
    await router.navigate({ to: '/agents' });

    expect(router.state.location.pathname).toBe('/admin/agents');
    expect(router.state.location.search).toMatchObject({ tab: 'scoreboard' });
  });
});
