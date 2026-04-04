import {
  type AnchorHTMLAttributes,
  createContext,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import styles from './index.module.css';

type SidebarContextValue = {
  mobileOpen: boolean;
  isMobile: boolean;
  setMobileOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

type SidebarProps = {
  children: ReactNode;
  side?: 'left' | 'right';
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

function cx(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ');
}

export function SidebarProvider(props: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    function handleResize() {
      const nextIsMobile = getIsMobile();
      setIsMobile(nextIsMobile);
      if (!nextIsMobile) {
        setMobileOpen(false);
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
        setMobileOpen((open) => !open);
      }
    }

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previousOverflow = document.body.style.overflow;
    if (isMobile && mobileOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
    document.body.style.overflow = previousOverflow;
    return undefined;
  }, [isMobile, mobileOpen]);

  const value = useMemo<SidebarContextValue>(
    () => ({
      mobileOpen,
      isMobile,
      setMobileOpen,
      toggleSidebar() {
        if (isMobile) {
          setMobileOpen((open) => !open);
        }
      },
    }),
    [isMobile, mobileOpen],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div className={styles.layout} style={props.style}>
        {props.children}
      </div>
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useSidebarContext();
  return {
    state: 'expanded' as const,
    openMobile: context.mobileOpen,
    setOpenMobile: context.setMobileOpen,
    isMobile: context.isMobile,
    toggleSidebar: context.toggleSidebar,
  };
}

export function Sidebar(props: SidebarProps) {
  const context = useSidebarContext();
  const isVisible = context.isMobile ? context.mobileOpen : true;
  const side = props.side ?? 'left';

  return (
    <>
      <button
        type="button"
        className={cx(
          styles.backdrop,
          context.isMobile && context.mobileOpen && styles.backdropVisible,
        )}
        aria-hidden={!context.isMobile || !context.mobileOpen}
        tabIndex={context.isMobile && context.mobileOpen ? 0 : -1}
        onClick={() => context.setMobileOpen(false)}
      />
      <aside
        className={cx(styles.root, isVisible && styles.rootVisible)}
        data-side={side}
        data-mobile={context.isMobile ? 'true' : undefined}
        data-state="expanded"
      >
        {props.children}
      </aside>
    </>
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
  const { state } = useSidebar();
  return (
    <main
      {...rest}
      className={cx(styles.inset, className)}
      data-sidebar-state={state}
    >
      {children}
    </main>
  );
}

export function SidebarTrigger(
  props: ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const { className, children, ...rest } = props;
  const context = useSidebarContext();

  if (!context.isMobile) return null;

  const label = context.mobileOpen ? 'Close sidebar' : 'Open sidebar';

  return (
    <button
      {...rest}
      type={props.type ?? 'button'}
      className={cx(styles.trigger, className)}
      aria-label={props['aria-label'] ?? label}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          context.toggleSidebar();
        }
      }}
    >
      {children ?? (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      )}
    </button>
  );
}

export function SidebarRail() {
  const { isMobile, toggleSidebar } = useSidebar();
  if (isMobile) return null;
  return (
    <button
      type="button"
      className={styles.rail}
      aria-label="Toggle sidebar"
      onClick={toggleSidebar}
    />
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

export function SidebarMenuButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
    isActive?: boolean;
    className?: string;
  },
) {
  const { className, isActive, children, ...rest } = props;
  return (
    <button
      {...rest}
      type={props.type ?? 'button'}
      className={cx(
        styles.menuButton,
        isActive && styles.menuButtonActive,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SidebarMenuAnchor(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children: ReactNode;
    isActive?: boolean;
  },
) {
  const { className, isActive, children, ...rest } = props;
  return (
    <a
      {...rest}
      className={cx(
        styles.menuButton,
        isActive && styles.menuButtonActive,
        className,
      )}
    >
      {children}
    </a>
  );
}

export function SidebarMenuBadge(props: { children: ReactNode }) {
  return <span className={styles.menuBadge}>{props.children}</span>;
}

export function SidebarFooterActions(props: {
  children: ReactNode;
}) {
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
