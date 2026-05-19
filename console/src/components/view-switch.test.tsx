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
  children: ReactNode;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, className, children }: MockLinkProps) => (
    <a data-router-link="true" href={to} className={className}>
      {children}
    </a>
  ),
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
    expect(agentsLink.getAttribute('href')).toBe('/agents');
    expect(agentsLink.dataset.routerLink).toBe('true');

    const docsLink = screen.getByRole('link', { name: 'Docs' });
    expect(docsLink.getAttribute('href')).toBe('/docs');
    expect(docsLink.dataset.routerLink).toBeUndefined();
  });

  it('marks the agents SPA view active by pathname', () => {
    mockRouterState.pathname = '/agents';

    render(<ViewSwitchNav />);

    const agentsItem = screen.getByText('Agents').closest('.view-switch-link');
    expect(agentsItem?.getAttribute('aria-current')).toBe('page');
    expect(agentsItem?.className).toContain('active');
  });
});
