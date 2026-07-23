import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button } from '../components/button';
import { TabbedPage } from '../components/tabbed-page';
import { AUTOMATION_TABS } from '../lib/admin-tabs';
import { logNavigationError } from '../lib/navigation';
import { JobsPage } from './jobs';
import { SchedulerPage } from './scheduler';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';

type AutomationTab = (typeof AUTOMATION_TABS)[number]['id'];

export function AutomationPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
    jobId?: string;
  };
  const activeTab = readRouteTab<AutomationTab>(
    search.tab,
    AUTOMATION_TABS,
    'work-queue',
  );

  function updateSearch(patch: Partial<typeof search>): void {
    void navigate({
      to: '/admin/automation',
      search: mergeRouteSearch(search, patch),
      replace: true,
    }).catch(logNavigationError);
  }

  return (
    <TabbedPage
      tabs={AUTOMATION_TABS}
      activeTab={activeTab}
      actions={
        <Button
          onClick={() => updateSearch({ tab: 'schedules', jobId: undefined })}
        >
          New schedule
        </Button>
      }
      onTabChange={(tab) => updateSearch({ tab })}
    >
      {activeTab === 'schedules' ? (
        <SchedulerPage embedded />
      ) : (
        <JobsPage embedded />
      )}
    </TabbedPage>
  );
}
