import { render } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

const AppSidebarMock = vi.hoisted(() => vi.fn());
const useQueryMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => vi.fn());
const useConfiguredViewSwitchItemsMock = vi.hoisted(() => vi.fn());
const ViewSwitchNavMock = vi.hoisted(() => vi.fn());
const routerStateMock = vi.hoisted(() => ({
  pathname: '/chat',
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: (params: {
    select: (state: { location: { pathname: string } }) => string;
  }) =>
    params.select({
      location: { pathname: routerStateMock.pathname },
    }),
}));

vi.mock('../api/client', () => ({
  fetchConfig: vi.fn(),
  validateToken: vi.fn(),
}));

vi.mock('../auth', () => ({
  isAuthReadyForApi: (auth: { status: string }) => auth.status === 'ready',
  useAuth: () => useAuthMock(),
}));

vi.mock('./admin-nav', () => ({
  resolveCurrentAdminNavItem: () => ({ label: 'Chat' }),
}));

vi.mock('./sidebar/app-sidebar', () => ({
  AppSidebar: (props: unknown) => {
    AppSidebarMock(props);
    return <aside data-testid="app-sidebar" />;
  },
}));

vi.mock('./sidebar/index', () => ({
  getSidebarStyleVars: () => ({}) as CSSProperties,
  MobileTopbarTrigger: () => null,
  SidebarInset: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  SidebarProvider: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('./sidebar/navigation', () => ({
  SIDEBAR_NAV_GROUPS: [
    {
      label: 'Labs',
      items: [
        {
          to: '/admin/local-models',
          label: 'Local Models',
          requiresLocalMac: true,
        },
        { to: '/admin/distill', label: 'Distill' },
      ],
    },
  ],
}));

vi.mock('./view-switch', () => ({
  useConfiguredViewSwitchItems: (token: string) =>
    useConfiguredViewSwitchItemsMock(token),
  ViewSwitchNav: (props: { items?: unknown }) => {
    ViewSwitchNavMock(props);
    return <nav data-testid="view-switch" />;
  },
}));

describe('AppShell config query', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      status: 'ready',
      token: '',
      gatewayStatus: { emailEnabled: false, version: 'test' },
      logout: vi.fn(),
    });
    useQueryMock.mockImplementation(
      ({ queryKey }: { queryKey: readonly string[] }) =>
        queryKey[0] === 'status' ? { data: { emailEnabled: false } } : {},
    );
    useConfiguredViewSwitchItemsMock.mockReset();
    useConfiguredViewSwitchItemsMock.mockReturnValue([
      { href: '/chat', label: 'Chat' },
    ]);
    ViewSwitchNavMock.mockReset();
  });

  it('passes runtime navigation config into the view switch', () => {
    render(
      <AppShell>
        <section />
      </AppShell>,
    );

    expect(useConfiguredViewSwitchItemsMock).toHaveBeenCalledWith('');
    expect(ViewSwitchNavMock).toHaveBeenCalledWith({
      items: [{ href: '/chat', label: 'Chat' }],
    });
  });
});

it.each([true, false, undefined])(
  'hides the native setup navigation unless supported, including at its direct URL: %s',
  (localModelsSupported) => {
    useAuthMock.mockReturnValue({
      status: 'ready',
      token: '',
      gatewayStatus: { version: 'test' },
      logout: vi.fn(),
    });
    useQueryMock.mockReturnValue({ data: { localModelsSupported } });
    routerStateMock.pathname = '/admin/local-models';
    render(
      <AppShell>
        <section />
      </AppShell>,
    );
    const groups = AppSidebarMock.mock.calls.at(-1)?.[0].groups as Array<{
      items: Array<{ to: string }>;
    }>;
    const routes = groups.flatMap((group) =>
      group.items.map((item) => item.to),
    );
    expect(routes.includes('/admin/local-models')).toBe(
      localModelsSupported === true,
    );
    expect(routes).toContain('/admin/distill');
  },
);
