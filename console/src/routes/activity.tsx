import { useNavigate, useSearch } from '@tanstack/react-router';
import { TabbedPage } from '../components/tabbed-page';
import { ACTIVITY_TABS } from '../lib/admin-tabs';
import { logNavigationError } from '../lib/navigation';
import { AuditPage } from './audit';
import type { TimeRange } from './audit-filters';
import { SessionsPage } from './sessions';
import { StatisticsPage } from './statistics';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';

const ACTIVITY_RANGES = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
] as const;

type ActivityTab = (typeof ACTIVITY_TABS)[number]['id'];
type ActivityRange = (typeof ACTIVITY_RANGES)[number]['value'];

function readActivityRange(value: string | undefined): ActivityRange {
  return ACTIVITY_RANGES.some((range) => range.value === value)
    ? (value as ActivityRange)
    : '30d';
}

export function ActivityPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
    range?: string;
    q?: string;
    sessionId?: string;
  };
  const activeTab = readRouteTab<ActivityTab>(
    search.tab,
    ACTIVITY_TABS,
    'usage',
  );
  const range = readActivityRange(search.range);
  const rangeDays =
    ACTIVITY_RANGES.find((option) => option.value === range)?.days ?? 30;

  function updateSearch(patch: Partial<typeof search>): void {
    void navigate({
      to: '/admin/activity',
      search: mergeRouteSearch(search, patch),
      replace: true,
    }).catch(logNavigationError);
  }

  return (
    <TabbedPage
      tabs={ACTIVITY_TABS}
      activeTab={activeTab}
      actions={
        <label className="header-actions">
          <span className="supporting-text">Range</span>
          <select
            aria-label="Activity time range"
            value={range}
            onChange={(event) => updateSearch({ range: event.target.value })}
          >
            {ACTIVITY_RANGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      }
      onTabChange={(tab) => updateSearch({ tab })}
    >
      {activeTab === 'sessions' ? (
        <SessionsPage embedded rangeDays={rangeDays} />
      ) : activeTab === 'audit' ? (
        <AuditPage
          embedded
          range={range as TimeRange}
          onRangeChange={(nextRange) => updateSearch({ range: nextRange })}
        />
      ) : (
        <StatisticsPage embedded days={rangeDays} />
      )}
    </TabbedPage>
  );
}
