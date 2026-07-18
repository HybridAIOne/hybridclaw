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
});
