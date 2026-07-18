export function readRouteTab<TabId extends string>(
  value: string | undefined,
  tabs: ReadonlyArray<{ id: TabId }>,
  fallback: TabId,
): TabId {
  return tabs.some((tab) => tab.id === value) ? (value as TabId) : fallback;
}

export function mergeRouteSearch<Search extends Record<string, unknown>>(
  current: Search,
  patch: Partial<Search>,
): Search {
  return { ...current, ...patch };
}
