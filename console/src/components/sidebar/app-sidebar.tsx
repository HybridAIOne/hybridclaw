import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { cx } from '../../lib/cx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog';
import { LogOut } from '../icons';
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
import type { SidebarNavGroup, SidebarNavItem } from './navigation';

export function AppSidebar(props: {
  groups: ReadonlyArray<SidebarNavGroup>;
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
        {props.groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu ariaLabel={group.label}>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarNavLink item={item} />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className={styles.footerBlock}>
          <SidebarMeta version={props.version} />
          <SidebarFooterActions>
            <SidebarFooterMenu>
              <SidebarFooterAction>
                <ThemeToggle labelClassName={styles.themeToggleLabel} />
              </SidebarFooterAction>
            </SidebarFooterMenu>
          </SidebarFooterActions>
        </div>
        {props.showLogout ? (
          <SidebarLogoutAction onLogout={props.onLogout} />
        ) : null}
      </SidebarFooter>
    </Sidebar>
  );
}

function SidebarBrand() {
  return (
    <div className={styles.brand}>
      <div className={styles.brandTitle}>
        <img
          className={styles.brandLogo}
          src="/static/hybridclaw-logo.svg"
          alt=""
          aria-hidden="true"
        />
        <span className={styles.brandWordmark}>HybridClaw</span>
      </div>
    </div>
  );
}

function SidebarNavLink(props: { item: SidebarNavItem }) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Link
      to={props.item.to}
      activeProps={{
        className: cx(styles.menuButton, styles.menuButtonActive),
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

function SidebarMeta(props: { version?: string }) {
  if (!props.version) return null;
  return (
    <div className={styles.footerMeta}>
      <span className={styles.footerValue}>v{props.version}</span>
    </div>
  );
}

function SidebarLogoutAction(props: { onLogout: () => void }) {
  const [forgetTokenOpen, setForgetTokenOpen] = useState(false);

  return (
    <>
      <div className={styles.footerDivider} />
      <SidebarFooterActions>
        <SidebarFooterMenu>
          <SidebarFooterAction>
            <button
              className={styles.footerButton}
              type="button"
              onClick={() => setForgetTokenOpen(true)}
            >
              <span className={styles.icon} aria-hidden="true">
                <LogOut />
              </span>
              Forget token
            </button>
          </SidebarFooterAction>
        </SidebarFooterMenu>
      </SidebarFooterActions>
      <Dialog open={forgetTokenOpen} onOpenChange={setForgetTokenOpen}>
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Forget token?</DialogTitle>
            <DialogDescription>
              You will be logged out and will need to enter your token again to
              access the admin console.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="ghost-button">Cancel</DialogClose>
            <DialogClose className="danger-button" onClick={props.onLogout}>
              Forget token
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
