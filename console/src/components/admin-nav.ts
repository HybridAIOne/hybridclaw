import { SIDEBAR_NAV_GROUPS, type SidebarNavItem } from './sidebar/navigation';

type AdminNavItemSummary = Pick<SidebarNavItem, 'to' | 'label'>;

const ALL_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> =
  SIDEBAR_NAV_GROUPS.flatMap((group) =>
    group.items.map(({ to, label }) => ({ to, label })),
  );

export function resolveCurrentAdminNavItem(
  pathname: string,
  navItems: ReadonlyArray<AdminNavItemSummary>,
): AdminNavItemSummary {
  return (
    navItems.find((item) => item.to === pathname) ??
    ALL_NAV_ITEMS.find((item) => item.to === pathname) ??
    ALL_NAV_ITEMS[0]
  );
}
