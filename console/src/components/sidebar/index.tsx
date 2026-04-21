import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import { PanelLeft } from '../icons';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  type SheetSide,
  SheetTitle,
} from '../sheet';
import styles from './index.module.css';

type SidebarState = 'expanded' | 'collapsed';

type SidebarContextValue = {
  state: SidebarState;
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

type SidebarCollapsible = 'icon' | 'none';

type SidebarProps = {
  children: ReactNode;
  side?: Extract<SheetSide, 'left' | 'right'>;
  collapsible?: SidebarCollapsible;
};

const SIDEBAR_MOBILE_BREAKPOINT = 1080;
const SIDEBAR_KEYBOARD_SHORTCUT = 'b';

const SidebarContext = createContext<SidebarContextValue | null>(null);

function useSidebarContext() {
  const value = useContext(SidebarContext);
  if (!value) {
    throw new Error('Sidebar components must be used within SidebarProvider.');
  }
  return value;
}

function getIsMobile() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < SIDEBAR_MOBILE_BREAKPOINT;
}

const DEFAULT_STORAGE_KEY = 'hybridclaw_sidebar_state';

function readPersistedOpen(
  defaultOpen: boolean,
  storageKey: string | false,
): boolean {
  if (!storageKey || typeof window === 'undefined') return defaultOpen;
  const stored = localStorage.getItem(storageKey);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultOpen;
}

export function SidebarProvider(props: {
  children: ReactNode;
  style?: CSSProperties;
  defaultOpen?: boolean;
  /** localStorage key for persisting state. Pass false to disable persistence. */
  storageKey?: string | false;
}) {
  const key = props.storageKey ?? DEFAULT_STORAGE_KEY;
  const [open, setOpenRaw] = useState(() =>
    readPersistedOpen(props.defaultOpen ?? true, key),
  );
  const setOpen = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      setOpenRaw((prev) => {
        const next = typeof value === 'function' ? value(prev) : value;
        if (next === prev) return prev;
        if (key) {
          try {
            localStorage.setItem(key, String(next));
          } catch {
            // localStorage may be unavailable
          }
        }
        return next;
      });
    },
    [key],
  );
  const [openMobile, setOpenMobile] = useState(false);
  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let wasMobile = getIsMobile();

    function handleResize() {
      const nextIsMobile = getIsMobile();
      if (nextIsMobile === wasMobile) return;
      wasMobile = nextIsMobile;
      setIsMobile(nextIsMobile);
      if (!nextIsMobile) {
        setOpenMobile(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== SIDEBAR_KEYBOARD_SHORTCUT) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      event.preventDefault();
      if (getIsMobile()) {
        setOpenMobile((o) => !o);
      } else {
        setOpen((o) => !o);
      }
    }

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [setOpen]);

  const value = useMemo<SidebarContextValue>(
    () => ({
      state: open ? 'expanded' : 'collapsed',
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar() {
        if (isMobile) {
          setOpenMobile((o) => !o);
        } else {
          setOpen((o) => !o);
        }
      },
    }),
    [isMobile, open, openMobile, setOpen],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div className={styles.layout} style={props.style}>
        {props.children}
      </div>
    </SidebarContext.Provider>
  );
}

export type SidebarContextSnapshot = SidebarContextValue;

export function useSidebar(): SidebarContextSnapshot {
  return useSidebarContext();
}

export function Sidebar({
  side = 'left',
  collapsible = 'icon',
  children,
}: SidebarProps) {
  const context = useSidebarContext();

  // Mobile: delegate entirely to Sheet which owns portalling, focus trap,
  // Escape, aria-hidden, and scroll lock.
  if (context.isMobile) {
    return (
      <Sheet open={context.openMobile} onOpenChange={context.setOpenMobile}>
        <SheetContent
          side={side}
          data-sidebar="sidebar"
          data-mobile="true"
          style={
            { '--sheet-width': 'var(--sidebar-width-mobile)' } as CSSProperties
          }
        >
          <SheetHeader>
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>Sidebar navigation panel.</SheetDescription>
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  // Non-collapsible sidebar — always expanded.
  if (collapsible === 'none') {
    return (
      <aside className={styles.root} data-side={side} data-state="expanded">
        {children}
      </aside>
    );
  }

  // Desktop: collapsible icon-rail panel.
  const state = context.open ? 'expanded' : 'collapsed';
  return (
    <aside className={styles.root} data-side={side} data-state={state}>
      {children}
    </aside>
  );
}

export function SidebarHeader(props: { children: ReactNode }) {
  return <div className={styles.header}>{props.children}</div>;
}

export function SidebarContent(props: { children: ReactNode }) {
  return <div className={styles.content}>{props.children}</div>;
}

export function SidebarFooter(props: { children: ReactNode }) {
  return <div className={styles.footer}>{props.children}</div>;
}

export function SidebarInset(
  props: HTMLAttributes<HTMLElement> & { children: ReactNode },
) {
  const { className, children, ...rest } = props;
  return (
    <main {...rest} className={cx(styles.inset, className)}>
      {children}
    </main>
  );
}

export function SidebarTrigger(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, children, ...rest } = props;
  const context = useSidebarContext();

  const label = context.isMobile
    ? context.openMobile
      ? 'Close sidebar'
      : 'Open sidebar'
    : context.open
      ? 'Collapse sidebar'
      : 'Expand sidebar';

  return (
    <button
      {...rest}
      type={props.type ?? 'button'}
      className={cx(styles.trigger, className)}
      aria-label={props['aria-label'] ?? label}
      aria-expanded={context.isMobile ? context.openMobile : context.open}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          context.toggleSidebar();
        }
      }}
    >
      {children ?? <PanelLeft />}
    </button>
  );
}

export function SidebarGroup(props: { children: ReactNode }) {
  return <section className={styles.group}>{props.children}</section>;
}

export function SidebarGroupLabel(props: { children: ReactNode }) {
  return <p className={styles.groupLabel}>{props.children}</p>;
}

export function SidebarGroupContent(props: { children: ReactNode }) {
  return <div className={styles.groupContent}>{props.children}</div>;
}

export function SidebarMenu(props: {
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <nav className={styles.menu} aria-label={props.ariaLabel}>
      {props.children}
    </nav>
  );
}

export function SidebarMenuItem(props: { children: ReactNode }) {
  return <div className={styles.menuItem}>{props.children}</div>;
}

export function SidebarFooterActions(props: { children: ReactNode }) {
  return <div className={styles.footerActions}>{props.children}</div>;
}

export function SidebarFooterMenu(props: { children: ReactNode }) {
  return <div className={styles.footerMenu}>{props.children}</div>;
}

export function SidebarFooterAction(props: { children: ReactNode }) {
  return <div className={styles.footerAction}>{props.children}</div>;
}

export function getSidebarStyleVars(width: string, mobileWidth = width) {
  return {
    '--sidebar-width': width,
    '--sidebar-width-icon': '4rem',
    '--sidebar-width-mobile': mobileWidth,
  } as CSSProperties;
}
