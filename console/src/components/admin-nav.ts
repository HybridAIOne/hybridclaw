import { SIDEBAR_NAV_GROUPS, type SidebarNavItem } from './sidebar/navigation';

type AdminNavItemSummary = Pick<SidebarNavItem, 'to' | 'label'>;

const NON_SIDEBAR_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> = [
  { to: '/agents', label: 'Agents' },
  { to: '/admin/network-policy', label: 'Network Policy' },
  { to: '/admin/safety-rules', label: 'Safety blocks' },
];

const ALL_NAV_ITEMS: ReadonlyArray<AdminNavItemSummary> =
  SIDEBAR_NAV_GROUPS.flatMap((group) =>
    group.items.map(({ to, label }) => ({ to, label })),
  ).concat(NON_SIDEBAR_NAV_ITEMS);

export function resolveCurrentAdminNavItem(
  pathname: string,
): AdminNavItemSummary {
  if (pathname.startsWith('/admin/skills/')) {
    return { to: '/admin/skills', label: 'Skill' };
  }

  return ALL_NAV_ITEMS.find((item) => item.to === pathname) ?? ALL_NAV_ITEMS[0];
}
