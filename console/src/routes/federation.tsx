import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button } from '../components/button';
import { TabbedPage } from '../components/tabbed-page';
import { FEDERATION_TABS } from '../lib/admin-tabs';
import { logNavigationError } from '../lib/navigation';
import { A2AInboxPage } from './a2a-inbox';
import { A2ATrustPage } from './a2a-trust';
import { FleetTopologyPage } from './fleet-topology';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';

type FederationTab = (typeof FEDERATION_TABS)[number]['id'];

export function FederationPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
  };
  const activeTab = readRouteTab<FederationTab>(
    search.tab,
    FEDERATION_TABS,
    'peers',
  );

  function updateSearch(patch: Partial<typeof search>): void {
    void navigate({
      to: '/admin/federation',
      search: mergeRouteSearch(search, patch),
      replace: true,
    }).catch(logNavigationError);
  }

  return (
    <TabbedPage
      tabs={FEDERATION_TABS}
      activeTab={activeTab}
      actions={
        <Button onClick={() => updateSearch({ tab: 'peers' })}>Add peer</Button>
      }
      onTabChange={(tab) => updateSearch({ tab })}
    >
      {activeTab === 'topology' ? (
        <FleetTopologyPage embedded />
      ) : activeTab === 'inbox' ? (
        <A2AInboxPage embedded />
      ) : (
        <A2ATrustPage embedded />
      )}
    </TabbedPage>
  );
}
