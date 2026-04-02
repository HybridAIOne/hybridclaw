import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSidebar } from './app-sidebar';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from './index';
import { SIDEBAR_NAV_ITEMS } from './navigation';

type MockLinkProps = {
  to: string;
  children: ReactNode;
  activeProps?: { className?: string };
  inactiveProps?: { className?: string };
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  title?: string;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    activeProps,
    inactiveProps,
    onClick,
    title,
  }: MockLinkProps) => (
    <a
      href={to}
      className={inactiveProps?.className ?? activeProps?.className}
      onClick={onClick}
      title={title}
    >
      {children}
    </a>
  ),
}));

vi.mock('../theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Mock Theme Toggle</button>,
}));

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

describe('Sidebar', () => {
  beforeEach(() => {
    setViewport(1440);
  });

  afterEach(() => {
    cleanup();
  });

  it('collapses on desktop when the trigger is clicked', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>Content</SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
        </Sidebar>
        <SidebarInset data-testid="inset">
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );

    const sidebar = container.querySelector('aside');
    const inset = screen.getByTestId('inset');
    const trigger = screen.getByRole('button', { name: 'Collapse sidebar' });

    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
    expect(sidebar?.getAttribute('data-collapsible')).toBeNull();
    expect(inset.getAttribute('data-sidebar-state')).toBe('expanded');

    fireEvent.click(trigger);

    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    expect(sidebar?.getAttribute('data-collapsible')).toBe('icon');
    expect(inset.getAttribute('data-sidebar-state')).toBe('collapsed');
  });

  it('toggles on keyboard shortcut and ignores editable inputs', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>
            <input aria-label="Search" />
          </SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
        </Sidebar>
        <SidebarInset>Body</SidebarInset>
      </SidebarProvider>,
    );

    const sidebar = container.querySelector('aside');
    const input = screen.getByLabelText('Search');

    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');

    fireEvent.keyDown(input, { key: 'b', ctrlKey: true });
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
  });

  it('opens on mobile and closes from the backdrop', () => {
    setViewport(900);

    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>Content</SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );

    const sidebar = container.querySelector('aside');
    const trigger = screen.getByRole('button', { name: 'Open sidebar' });

    expect(sidebar?.getAttribute('data-mobile')).toBe('true');
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(trigger);

    const backdrop = container.querySelector('button[aria-hidden="false"]');
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeDefined();
    expect(document.body.style.overflow).toBe('hidden');
    expect(backdrop).not.toBeNull();

    fireEvent.click(backdrop as HTMLButtonElement);

    expect(document.body.style.overflow).toBe('');
    expect(container.querySelector('button[aria-hidden="false"]')).toBeNull();
  });

  it('renders the composed app sidebar with grouped navigation and footer controls', () => {
    const handleLogout = vi.fn();

    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          version="0.10.0"
          showLogout
          onLogout={handleLogout}
        />
      </SidebarProvider>,
    );

    expect(screen.getByText('HybridClaw')).toBeDefined();
    expect(screen.getByText('Admin console')).toBeDefined();
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('Runtime')).toBeDefined();
    expect(screen.getByText('Configuration')).toBeDefined();
    expect(screen.getByText('v0.10.0')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mock Theme Toggle' })).toBeDefined();

    const logout = screen.getByRole('button', { name: 'Forget token' });
    fireEvent.click(logout);
    expect(handleLogout).toHaveBeenCalledTimes(1);
  });
});
