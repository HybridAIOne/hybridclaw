import { SIDEBAR_NAV_GROUPS, type SidebarNavItem } from './sidebar/navigation';

type AdminNavItemSummary = Pick<SidebarNavItem, 'to' | 'label'>;

const TOP_LEVEL_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> = [
  { to: '/agents', label: 'Agents' },
];

const ALL_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> =
  SIDEBAR_NAV_GROUPS.flatMap((group) =>
    group.items.map(({ to, label }) => ({ to, label })),
  ).concat(TOP_LEVEL_NAV_ITEMS);

export function resolveCurrentAdminNavItem(
  pathname: string,
): AdminNavItemSummary {
  return ALL_NAV_ITEMS.find((item) => item.to === pathname) ?? ALL_NAV_ITEMS[0];
}
