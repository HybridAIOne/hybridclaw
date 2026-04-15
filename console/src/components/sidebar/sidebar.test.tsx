import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSidebar } from './app-sidebar';
import {
  Sidebar,
  SidebarContent,
  type SidebarContextSnapshot,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './index';
import { SIDEBAR_NAV_GROUPS } from './navigation';

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

type SidebarCtx = SidebarContextSnapshot;

// Helper: expose useSidebar return value to assertions
function SidebarContextSpy(props: { onRender: (ctx: SidebarCtx) => void }) {
  const ctx = useSidebar();
  props.onRender(ctx);
  return null;
}

describe('SidebarProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(1440);
  });
  afterEach(cleanup);

  it('exposes full context shape', () => {
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(captured.value).toMatchObject({
      state: 'expanded',
      open: true,
      isMobile: false,
      openMobile: false,
    });
    expect(typeof captured.value?.setOpen).toBe('function');
    expect(typeof captured.value?.setOpenMobile).toBe('function');
    expect(typeof captured.value?.toggleSidebar).toBe('function');
  });

  it('toggleSidebar toggles open on desktop', () => {
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(captured.value?.open).toBe(true);
    act(() => captured.value?.toggleSidebar());
    expect(captured.value?.open).toBe(false);
    expect(captured.value?.state).toBe('collapsed');
  });

  it('toggleSidebar toggles openMobile on mobile', () => {
    setViewport(800);
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(captured.value?.openMobile).toBe(false);
    act(() => captured.value?.toggleSidebar());
    expect(captured.value?.openMobile).toBe(true);
    expect(captured.value?.open).toBe(true); // desktop open unchanged
  });

  it('clears openMobile when resizing from mobile to desktop', () => {
    setViewport(800);
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );
    act(() => captured.value?.setOpenMobile(true));
    expect(captured.value?.openMobile).toBe(true);

    act(() => setViewport(1440));
    expect(captured.value?.openMobile).toBe(false);
    expect(captured.value?.isMobile).toBe(false);
  });

  it('locks body scroll when mobile sidebar is open and restores on close', () => {
    setViewport(800);
    // Scroll lock is Sheet's responsibility — render a Sidebar so Sheet runs.
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );
    expect(document.body.style.overflow).toBe('');
    act(() => captured.value?.setOpenMobile(true));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => captured.value?.setOpenMobile(false));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Sidebar — desktop', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(1440);
  });
  afterEach(cleanup);

  it('renders expanded by default', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });

  it('trigger collapses and re-expands the sidebar', () => {
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
    const aside = container.querySelector('aside');
    const trigger = screen.getByRole('button', { name: 'Collapse sidebar' });

    fireEvent.click(trigger);
    expect(aside?.getAttribute('data-state')).toBe('collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });
});

describe('Sidebar — mobile overlay', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(900);
  });
  afterEach(cleanup);

  it('renders as mobile overlay with data-mobile="true"', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    // Mobile sidebar is portalled to document.body by Sheet — query from there.
    const panel = document.body.querySelector('[data-mobile="true"]');
    expect(panel?.getAttribute('data-mobile')).toBe('true');
  });

  it('mobile drawer has role="dialog", aria-modal, and accessible title', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // Sheet links the dialog to its title via aria-labelledby (not aria-label).
    const titleId = dialog?.getAttribute('aria-labelledby') ?? '';
    expect(titleId).not.toBe('');
    expect(document.getElementById(titleId)?.textContent).toBe('Navigation');
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
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );

    // Trigger is accessible before opening (not yet aria-hidden).
    const trigger = screen.getByRole('button', { name: 'Open sidebar' });
    fireEvent.click(trigger);

    // After opening, useHideOthers hides the main layout (including the trigger)
    // from the a11y tree — query the trigger by attribute directly.
    expect(
      document.body.querySelector('[aria-label="Close sidebar"]'),
    ).not.toBeNull();
    expect(captured.value?.openMobile).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    // Sheet overlay is portalled to document.body with data-sheet="overlay".
    const backdrop = document.body.querySelector('[data-sheet="overlay"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as HTMLElement);

    expect(captured.value?.openMobile).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('Escape closes mobile drawer', () => {
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );
    act(() => captured.value?.setOpenMobile(true));
    expect(captured.value?.openMobile).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(captured.value?.openMobile).toBe(false);
  });

  it('opens and closes via Ctrl+B keyboard shortcut on mobile', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );

    // The aside is portalled to document.body; visibility is via CSS class.
    // We check open state via context spy instead.
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );

    expect(captured.value?.openMobile).toBe(false);
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(captured.value?.openMobile).toBe(true);
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(captured.value?.openMobile).toBe(false);

    // desktop open state unchanged
    expect(captured.value?.open).toBe(true);
  });
});

describe('SidebarTrigger', () => {
  beforeEach(() => localStorage.clear());
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
    const onClick = vi.fn((e: { preventDefault(): void }) =>
      e.preventDefault(),
    );
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

describe('AppSidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(1440);
  });
  afterEach(cleanup);

  it('renders brand and nav sections', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
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
          groups={SIDEBAR_NAV_GROUPS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    for (const item of SIDEBAR_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(screen.getByText(item.label)).toBeDefined();
    }
    expect(screen.queryByText('Chat')).toBeNull();
  });

  it('renders version when provided', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
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
          groups={SIDEBAR_NAV_GROUPS}
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
          groups={SIDEBAR_NAV_GROUPS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Mock Theme Toggle' }),
    ).toBeDefined();
  });

  it('opens a confirmation dialog before calling onLogout', () => {
    const onLogout = vi.fn();
    render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
          version="0.10.0"
          showLogout
          onLogout={onLogout}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Forget token' }));
    expect(onLogout).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Forget token?')).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Forget token' }),
    );
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('does not render logout button when showLogout=false', () => {
    render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Forget token' })).toBeNull();
  });

  it('desktop sidebar starts expanded and collapses on trigger click', () => {
    const { container } = render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-state')).toBe('expanded');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(aside?.getAttribute('data-state')).toBe('collapsed');
  });

  it('closes mobile sidebar when a nav link is clicked', () => {
    setViewport(800);
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
          showLogout={false}
          onLogout={vi.fn()}
        />
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );

    act(() => captured.value?.setOpenMobile(true));
    expect(captured.value?.openMobile).toBe(true);

    const dashboardLink = screen.getByText('Dashboard').closest('a');
    expect(dashboardLink).not.toBeNull();
    fireEvent.click(dashboardLink as HTMLAnchorElement);

    expect(captured.value?.openMobile).toBe(false);
  });

  it('renders as mobile overlay on small screens', () => {
    setViewport(800);
    render(
      <SidebarProvider>
        <AppSidebar
          groups={SIDEBAR_NAV_GROUPS}
          showLogout={false}
          onLogout={vi.fn()}
        />
      </SidebarProvider>,
    );
    // Sheet portals a section[role="dialog"] to document.body.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('data-mobile')).toBe('true');
  });
});

describe('Editable-element guards', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('Escape does not close mobile drawer when focus is in an input', () => {
    setViewport(800);
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <input data-testid="inner-input" />
          </SidebarContent>
        </Sidebar>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );

    act(() => captured.value?.setOpenMobile(true));
    expect(captured.value?.openMobile).toBe(true);

    const input = screen.getByTestId('inner-input');
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(captured.value?.openMobile).toBe(true);
  });

  it('Ctrl+B does not toggle when focus is in a textarea', () => {
    setViewport(1440);
    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <textarea data-testid="inner-textarea" />
          </SidebarContent>
        </Sidebar>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );

    expect(captured.value?.open).toBe(true);

    const textarea = screen.getByTestId('inner-textarea');
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });

    expect(captured.value?.open).toBe(true);
  });
});

describe('Error boundaries', () => {
  afterEach(cleanup);

  it('useSidebar throws when used outside SidebarProvider', () => {
    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useSidebar())).toThrow(
      'Sidebar components must be used within SidebarProvider.',
    );
    spy.mockRestore();
  });
});

describe('useHideOthers', () => {
  afterEach(cleanup);

  it('sets inert on siblings when mobile drawer is open', () => {
    setViewport(800);
    const sibling = document.createElement('div');
    sibling.setAttribute('data-testid', 'app-sibling');
    document.body.appendChild(sibling);

    const captured = { value: null as SidebarCtx | null };
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
        <SidebarContextSpy
          onRender={(ctx) => {
            captured.value = ctx;
          }}
        />
      </SidebarProvider>,
    );

    act(() => captured.value?.setOpenMobile(true));
    expect((sibling as HTMLElement).inert).toBe(true);

    act(() => captured.value?.setOpenMobile(false));
    expect((sibling as HTMLElement).inert).toBe(false);

    document.body.removeChild(sibling);
  });
});
