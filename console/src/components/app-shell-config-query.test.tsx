import { render } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

const useQueryMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => vi.fn());
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
  useAuth: () => useAuthMock(),
}));

vi.mock('./admin-nav', () => ({
  resolveCurrentAdminNavItem: () => ({ label: 'Chat' }),
}));

vi.mock('./sidebar/app-sidebar', () => ({
  AppSidebar: () => <aside data-testid="app-sidebar" />,
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
  SIDEBAR_NAV_GROUPS: [],
}));

vi.mock('./view-switch', () => ({
  ViewSwitchNav: () => <nav data-testid="view-switch" />,
}));

describe('AppShell config query', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      token: 'admin-token',
      gatewayStatus: { emailEnabled: false, version: 'test' },
      logout: vi.fn(),
    });
    useQueryMock.mockImplementation(
      ({ queryKey }: { queryKey: readonly string[] }) =>
        queryKey[0] === 'config'
          ? { data: { config: { ui: { navigation: [] } } } }
          : { data: { emailEnabled: false } },
    );
  });

  it('refreshes runtime config so navigation changes become visible', () => {
    render(
      <AppShell>
        <section />
      </AppShell>,
    );

    const configQueryOptions = useQueryMock.mock.calls
      .map(([options]) => options as { queryKey: readonly string[] })
      .find((options) => options.queryKey[0] === 'config') as
      | {
          refetchInterval?: number;
          refetchOnWindowFocus?: boolean;
        }
      | undefined;

    expect(configQueryOptions).toMatchObject({
      refetchInterval: 5000,
      refetchOnWindowFocus: true,
    });
  });
});
