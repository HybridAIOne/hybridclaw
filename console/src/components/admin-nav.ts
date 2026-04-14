import { SIDEBAR_NAV_GROUPS, type SidebarNavItem } from './sidebar/navigation';

type AdminNavItemSummary = Pick<SidebarNavItem, 'to' | 'label'>;

const ALL_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> =
  SIDEBAR_NAV_GROUPS.flatMap((group) =>
    group.items.map(({ to, label }) => ({ to, label })),
  );

const HIDDEN_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> = [
  { to: '/chat', label: 'Chat' },
];

export function resolveCurrentAdminNavItem(
  adminPath: string,
  navItems: ReadonlyArray<AdminNavItemSummary>,
): AdminNavItemSummary {
  return (
    navItems.find((item) => item.to === adminPath) ??
    HIDDEN_NAV_ITEMS.find((item) => item.to === adminPath) ??
    ALL_NAV_ITEMS[0]
  );
}
