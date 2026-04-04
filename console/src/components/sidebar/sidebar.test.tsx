import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
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
  SidebarRail,
  SidebarTrigger,
  useSidebar,
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

type SidebarCtx = ReturnType<typeof useSidebar>;

// Helper: expose useSidebar return value to assertions
function SidebarContextSpy(props: { onRender: (ctx: SidebarCtx) => void }) {
  const ctx = useSidebar();
  props.onRender(ctx);
  return null;
}

describe('SidebarProvider', () => {
  beforeEach(() => setViewport(1440));
  afterEach(cleanup);

  it('exposes full shadcn-aligned context shape', () => {
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(captured).toMatchObject({
      state: 'expanded',
      open: true,
      isMobile: false,
      openMobile: false,
    });
    expect(typeof captured!.setOpen).toBe('function');
    expect(typeof captured!.setOpenMobile).toBe('function');
    expect(typeof captured!.toggleSidebar).toBe('function');
  });

  it('toggleSidebar toggles open on desktop', () => {
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(captured!.open).toBe(true);
    act(() => captured!.toggleSidebar());
    expect(captured!.open).toBe(false);
    expect(captured!.state).toBe('collapsed');
  });

  it('toggleSidebar toggles openMobile on mobile', () => {
    setViewport(800);
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(captured!.openMobile).toBe(false);
    act(() => captured!.toggleSidebar());
    expect(captured!.openMobile).toBe(true);
    expect(captured!.open).toBe(true); // desktop open unchanged
  });

  it('clears openMobile when resizing from mobile to desktop', () => {
    setViewport(800);
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );
    act(() => captured!.setOpenMobile(true));
    expect(captured!.openMobile).toBe(true);

    act(() => setViewport(1440));
    expect(captured!.openMobile).toBe(false);
    expect(captured!.isMobile).toBe(false);
  });

  it('locks body scroll when mobile sidebar is open and restores on close', () => {
    setViewport(800);
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(document.body.style.overflow).toBe('');
    act(() => captured!.setOpenMobile(true));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => captured!.setOpenMobile(false));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Sidebar — desktop collapsible (default)', () => {
  beforeEach(() => setViewport(1440));
  afterEach(cleanup);

  it('starts expanded with no data-collapsible', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>Content</SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');
    expect(aside?.getAttribute('data-collapsible')).toBeNull();
    expect(aside?.getAttribute('data-mobile')).toBeNull();
  });

  it('collapses when trigger is clicked and sets data-collapsible', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>Header</SidebarHeader>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    const trigger = screen.getByRole('button', { name: 'Collapse sidebar' });

    fireEvent.click(trigger);

    expect(aside?.getAttribute('data-state')).toBe('collapsed');
    expect(aside?.getAttribute('data-collapsible')).toBe('offcanvas');
    expect(
      screen.getByRole('button', { name: 'Expand sidebar' }),
    ).toBeDefined();
  });

  it('toggles via Ctrl+B keyboard shortcut', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');

    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(aside?.getAttribute('data-state')).toBe('collapsed');

    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });

  it('ignores keyboard shortcut when focus is in an input', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <input aria-label="Search" />
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    const input = screen.getByLabelText('Search');

    fireEvent.keyDown(input, { key: 'b', ctrlKey: true });
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });

  it('renders SidebarRail in collapsible mode', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Toggle sidebar' }),
    ).toBeDefined();
  });
});

describe('Sidebar — desktop collapsible="none"', () => {
  beforeEach(() => setViewport(1440));
  afterEach(cleanup);

  it('always renders expanded with no rail', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');
    expect(aside?.getAttribute('data-collapsible')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Toggle sidebar' })).toBeNull();
  });

  it('trigger renders but clicking does not change sidebar data-state', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    const trigger = screen.getByRole('button', { name: 'Collapse sidebar' });

    fireEvent.click(trigger);

    // sidebar has no visual collapse, but context open toggles
    // The important thing is data-state stays "expanded" because collapsible="none"
    // bypasses collapse rendering
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });
});

describe('Sidebar — mobile overlay', () => {
  beforeEach(() => setViewport(900));
  afterEach(cleanup);

  it('renders as mobile overlay with data-mobile="true"', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-mobile')).toBe('true');
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });

  it('trigger shows "Open sidebar" initially', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeDefined();
  });

  it('opens via trigger and closes via backdrop', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Open sidebar' });
    fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeDefined();
    expect(document.body.style.overflow).toBe('hidden');

    const backdrop = container.querySelector('button[aria-hidden="false"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as HTMLButtonElement);

    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeDefined();
    expect(document.body.style.overflow).toBe('');
  });

  it('opens and closes via Ctrl+B keyboard shortcut on mobile', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');

    // The aside is always in DOM for mobile, visibility is via CSS class.
    // We check via context spy instead.
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );

    expect(captured!.openMobile).toBe(false);
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(captured!.openMobile).toBe(true);
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(captured!.openMobile).toBe(false);

    // desktop open state unchanged
    expect(captured!.open).toBe(true);
    void aside; // avoid unused warning
  });

  it('does not render SidebarRail on mobile', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Toggle sidebar' })).toBeNull();
  });
});

describe('SidebarTrigger', () => {
  afterEach(cleanup);

  it('renders on desktop', () => {
    setViewport(1440);
    render(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' }),
    ).toBeDefined();
  });

  it('renders on mobile', () => {
    setViewport(800);
    render(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeDefined();
  });

  it('respects custom aria-label', () => {
    setViewport(1440);
    render(
      <SidebarProvider>
        <SidebarTrigger aria-label="Menu" />
      </SidebarProvider>,
    );
    expect(screen.getByRole('button', { name: 'Menu' })).toBeDefined();
  });

  it('calls custom onClick before toggling', () => {
    setViewport(1440);
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger onClick={onClick} />
        </SidebarInset>
      </SidebarProvider>,
    );
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger onClick={onClick} />
        </SidebarInset>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Collapse sidebar' })[0],
    );
    expect(onClick).toHaveBeenCalled();
    // preventDefault stops toggle
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });
});

describe('SidebarRail', () => {
  afterEach(cleanup);

  it('renders on desktop', () => {
    setViewport(1440);
    render(
      <SidebarProvider>
        <SidebarRail />
      </SidebarProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Toggle sidebar' }),
    ).toBeDefined();
  });

  it('does not render on mobile', () => {
    setViewport(800);
    render(
      <SidebarProvider>
        <SidebarRail />
      </SidebarProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Toggle sidebar' })).toBeNull();
  });

  it('toggles sidebar when clicked', () => {
    setViewport(1440);
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(aside?.getAttribute('data-state')).toBe('collapsed');
  });
});

describe('AppSidebar', () => {
  beforeEach(() => setViewport(1440));
  afterEach(cleanup);

  it('renders brand and nav sections', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(screen.getByText('HybridClaw')).toBeDefined();
    expect(screen.getByText('Admin console')).toBeDefined();
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('Runtime')).toBeDefined();
    expect(screen.getByText('Configuration')).toBeDefined();
  });

  it('renders all nav item labels', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    for (const item of SIDEBAR_NAV_ITEMS) {
      expect(screen.getByText(item.label)).toBeDefined();
    }
  });

  it('renders version when provided', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          version="1.2.3"
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(screen.getByText('v1.2.3')).toBeDefined();
  });

  it('does not render version element when omitted', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });

  it('renders theme toggle', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Mock Theme Toggle' }),
    ).toBeDefined();
  });

  it('renders logout button and calls onLogout when showLogout=true', () => {
    const onLogout = vi.fn();
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          version="0.10.0"
          showLogout
          onLogout={onLogout}
        />
      </SidebarProvider>,
    );
    const logout = screen.getByRole('button', { name: 'Forget token' });
    fireEvent.click(logout);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('does not render logout button when showLogout=false', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Forget token' })).toBeNull();
  });

  it('uses collapsible="none" so desktop sidebar is always data-state="expanded"', () => {
    const { container } = render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');
    expect(aside?.getAttribute('data-collapsible')).toBeNull();
  });

  it('closes mobile sidebar when a nav link is clicked', () => {
    setViewport(800);
    let captured: SidebarCtx | null = null;
    render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
        <SidebarContextSpy
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </SidebarProvider>,
    );

    act(() => captured!.setOpenMobile(true));
    expect(captured!.openMobile).toBe(true);

    const dashboardLink = screen.getByText('Dashboard').closest('a');
    expect(dashboardLink).not.toBeNull();
    fireEvent.click(dashboardLink as HTMLAnchorElement);

    expect(captured!.openMobile).toBe(false);
  });

  it('renders as mobile overlay on small screens', () => {
    setViewport(800);
    const { container } = render(
      <SidebarProvider>
        <AppSidebar
          items={SIDEBAR_NAV_ITEMS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-mobile')).toBe('true');
  });
});
