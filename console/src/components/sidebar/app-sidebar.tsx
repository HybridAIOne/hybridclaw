import { Link } from '@tanstack/react-router';
import { Admin, Cog } from '../icons';
import { ThemeToggle } from '../theme-toggle';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarFooterAction,
  SidebarFooterActions,
  SidebarFooterMenu,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from './index';
import styles from './index.module.css';
import type { SidebarNavItem } from './navigation';

const NAV_SECTIONS: ReadonlyArray<{
  key: SidebarNavItem['section'];
  label: string;
}> = [
  { key: 'overview', label: 'Overview' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'configuration', label: 'Configuration' },
];

export function AppSidebar(props: {
  items: ReadonlyArray<SidebarNavItem>;
  version?: string;
  showLogout: boolean;
  onLogout: () => void;
}) {
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarBrand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav items={props.items} />
      </SidebarContent>
      <SidebarFooter>
        <div className={styles.footerBlock}>
          <SidebarMeta version={props.version} />
          <SidebarActions
            showLogout={props.showLogout}
            onLogout={props.onLogout}
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function SidebarBrand() {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <div className={styles.brand}>
      <div className={styles.brandTitle}>
        <span className={styles.brandMark} aria-hidden="true">
          <Admin />
        </span>
        {!collapsed ? (
          <div className={styles.brandText}>
            <h1>HybridClaw</h1>
            <span className={styles.eyebrow}>Admin console</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SidebarNav(props: { items: ReadonlyArray<SidebarNavItem> }) {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <div className={styles.sectionStack}>
      {NAV_SECTIONS.map((section) => {
        const items = props.items.filter(
          (item) => item.section === section.key,
        );
        if (items.length === 0) return null;

        return (
          <SidebarGroup key={section.key}>
            {!collapsed ? (
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            ) : null}
            <SidebarGroupContent>
              <SidebarMenu ariaLabel={section.label}>
                {items.map((item) => {
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarNavLink item={item} />
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </div>
  );
}

export function SidebarNavLink(props: { item: SidebarNavItem }) {
  const { isMobile, setOpenMobile, state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <Link
      to={props.item.to}
      activeProps={{
        className: `${styles.menuButton} ${styles.menuButtonActive}`,
      }}
      inactiveProps={{ className: styles.menuButton }}
      activeOptions={{ exact: props.item.to === '/' }}
      title={collapsed ? props.item.label : undefined}
      onClick={() => {
        if (isMobile) {
          setOpenMobile(false);
        }
      }}
    >
      <span className={styles.menuIcon} aria-hidden="true">
        <props.item.icon />
      </span>
      {!collapsed ? <span>{props.item.label}</span> : null}
    </Link>
  );
}

export function SidebarMeta(props: { version?: string }) {
  const { state } = useSidebar();
  if (!props.version || state === 'collapsed') return null;
  return (
    <div className={styles.footerMeta}>
      <span className={styles.footerValue}>v{props.version}</span>
    </div>
  );
}

export function SidebarActions(props: {
  showLogout: boolean;
  onLogout: () => void;
}) {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <SidebarFooterActions>
      <SidebarFooterMenu>
        <SidebarFooterAction>
          <ThemeToggle />
        </SidebarFooterAction>
        {props.showLogout ? (
          <SidebarFooterAction>
            {collapsed ? (
              <button
                className={styles.iconButton}
                type="button"
                aria-label="Forget token"
                title="Forget token"
                onClick={props.onLogout}
              >
                <span className={styles.icon} aria-hidden="true">
                  <Cog />
                </span>
              </button>
            ) : (
              <button
                className={styles.footerButton}
                type="button"
                onClick={props.onLogout}
              >
                <span className={styles.icon} aria-hidden="true">
                  <Cog />
                </span>
                Forget token
              </button>
            )}
          </SidebarFooterAction>
        ) : null}
      </SidebarFooterMenu>
    </SidebarFooterActions>
  );
}
