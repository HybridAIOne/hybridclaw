import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewSwitchNav } from './view-switch';

const mockRouterState = vi.hoisted(() => ({
  pathname: '/chat',
}));

type MockLinkProps = {
  to: string;
  className?: string;
  activeOptions?: { exact?: boolean };
  children: ReactNode;
};

// Mirrors the router's own active marking, including the fuzzy prefix match it
// applies by default, so the nav's active resolution stays the only source.
function isRouterActive(to: string, exact: boolean | undefined): boolean {
  const { pathname } = mockRouterState;
  if (exact) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, className, activeOptions, children }: MockLinkProps) => {
    const active = isRouterActive(to, activeOptions?.exact);
    return (
      <a
        data-router-link="true"
        href={to}
        className={active ? `${className} active` : className}
        aria-current={active ? 'page' : undefined}
      >
        {children}
      </a>
    );
  },
  useRouterState: (params: {
    select: (state: { location: { pathname: string } }) => string;
  }) =>
    params.select({
      location: { pathname: mockRouterState.pathname },
    }),
}));

describe('ViewSwitchNav', () => {
  beforeEach(() => {
    mockRouterState.pathname = '/chat';
  });

  it('uses client router links only for console routes', () => {
    mockRouterState.pathname = '/chat';

    render(<ViewSwitchNav />);

    expect(screen.getByRole('link', { name: 'Admin' }).dataset.routerLink).toBe(
      'true',
    );

    const agentsLink = screen.getByRole('link', { name: 'Agents' });
    expect(agentsLink.getAttribute('href')).toBe('/admin/agents');
    expect(agentsLink.dataset.routerLink).toBe('true');

    const docsLink = screen.getByRole('link', { name: 'Docs' });
    expect(docsLink.getAttribute('href')).toBe('/docs');
    expect(docsLink.dataset.routerLink).toBeUndefined();
  });

  it('marks the agents SPA view active by pathname', () => {
    mockRouterState.pathname = '/admin/agents';

    render(<ViewSwitchNav />);

    const agentsItem = screen.getByText('Agents').closest('.view-switch-link');
    expect(agentsItem?.getAttribute('aria-current')).toBe('page');
    expect(agentsItem?.className).toContain('active');

    const adminItem = screen.getByText('Admin').closest('.view-switch-link');
    expect(adminItem?.getAttribute('aria-current')).toBeNull();
    expect(adminItem?.className).not.toContain('active');
  });

  it('renders custom local and external navigation items', () => {
    mockRouterState.pathname = '/admin/channels';

    render(
      <ViewSwitchNav
        items={[
          { label: 'Channels', href: '/admin/channels' },
          { label: 'Cloud', href: 'https://hybridclaw.io' },
        ]}
      />,
    );

    const channelsLink = screen
      .getByText('Channels')
      .closest('.view-switch-link');
    expect(channelsLink?.getAttribute('aria-current')).toBe('page');
    expect(channelsLink?.className).toContain('active');

    const cloudLink = screen.getByRole('link', { name: 'Cloud' });
    expect(cloudLink.getAttribute('href')).toBe('https://hybridclaw.io');
    expect(cloudLink.getAttribute('target')).toBe('_blank');
    expect(cloudLink.dataset.routerLink).toBeUndefined();
    expect(screen.queryByText('Chat')).toBeNull();
  });

  it('renders configured navigation images', () => {
    render(<ViewSwitchNav />);

    expect(
      screen
        .getByRole('link', { name: 'GitHub' })
        .querySelector('img')
        ?.getAttribute('src'),
    ).toBe('/icons/github.svg');
  });

  it('uses images only when the item explicitly configures one', () => {
    render(
      <ViewSwitchNav
        items={[
          {
            label: 'GitHub',
            href: 'https://github.com/HybridAIOne/hybridclaw',
          },
          {
            label: 'HybridAI',
            href: 'https://hybridai.one/admin_startpage',
            image: '/icons/hybridai.png',
          },
        ]}
      />,
    );

    const githubLink = screen.getByRole('link', { name: 'GitHub' });
    expect(githubLink.querySelector('img')).toBeNull();
    expect(githubLink.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 24 24',
    );
    expect(
      screen
        .getByRole('link', { name: 'HybridAI' })
        .querySelector('img')
        ?.getAttribute('src'),
    ).toBe('/icons/hybridai.png');
  });

  it('hides the navigation strip when explicitly configured empty', () => {
    const { container } = render(<ViewSwitchNav items={[]} />);

    expect(container.querySelector('.view-switch')).toBeNull();
  });
});
