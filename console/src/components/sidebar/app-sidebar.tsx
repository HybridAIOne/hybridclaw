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
    <Sidebar collapsible="none">
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
  return (
    <div className={styles.brand}>
      <div className={styles.brandTitle}>
        <span className={styles.brandMark} aria-hidden="true">
          <Admin />
        </span>
        <div className={styles.brandText}>
          <h1>HybridClaw</h1>
          <span className={styles.eyebrow}>Admin console</span>
        </div>
      </div>
    </div>
  );
}

export function SidebarNav(props: { items: ReadonlyArray<SidebarNavItem> }) {
  return (
    <div className={styles.sectionStack}>
      {NAV_SECTIONS.map((section) => {
        const items = props.items.filter(
          (item) => item.section === section.key,
        );
        if (items.length === 0) return null;

        return (
          <SidebarGroup key={section.key}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu ariaLabel={section.label}>
                {items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarNavLink item={item} />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </div>
  );
}

export function SidebarNavLink(props: { item: SidebarNavItem }) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Link
      to={props.item.to}
      activeProps={{
        className: `${styles.menuButton} ${styles.menuButtonActive}`,
      }}
      inactiveProps={{ className: styles.menuButton }}
      activeOptions={{ exact: props.item.to === '/' }}
      onClick={() => {
        if (isMobile) {
          setOpenMobile(false);
        }
      }}
    >
      <span className={styles.menuIcon} aria-hidden="true">
        <props.item.icon />
      </span>
      <span>{props.item.label}</span>
    </Link>
  );
}

export function SidebarMeta(props: { version?: string }) {
  if (!props.version) return null;
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
  return (
    <SidebarFooterActions>
      <SidebarFooterMenu>
        <SidebarFooterAction>
          <ThemeToggle />
        </SidebarFooterAction>
        {props.showLogout ? (
          <SidebarFooterAction>
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
          </SidebarFooterAction>
        ) : null}
      </SidebarFooterMenu>
    </SidebarFooterActions>
  );
}
