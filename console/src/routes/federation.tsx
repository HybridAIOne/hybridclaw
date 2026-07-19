import { useNavigate, useSearch } from '@tanstack/react-router';
import { TabbedPage } from '../components/tabbed-page';
import { logNavigationError } from '../lib/navigation';
import { A2AInboxPage } from './a2a-inbox';
import { A2ATrustPage } from './a2a-trust';
import { FleetTopologyPage } from './fleet-topology';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';

const FEDERATION_TABS = [
  { id: 'peers', label: 'Peers & trust' },
  { id: 'topology', label: 'Fleet topology' },
  { id: 'inbox', label: 'A2A inbox' },
] as const;

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
        <button
          className="primary-button"
          type="button"
          onClick={() => updateSearch({ tab: 'peers' })}
        >
          Add peer
        </button>
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
