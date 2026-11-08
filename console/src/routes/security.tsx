/**
 * One security workspace groups approval modes, hard guards and network policy.
 * Each tab keeps its own enforcement API; this navigation grants no permissions.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { TabbedPage } from '../components/tabbed-page';
import { SECURITY_TABS } from '../lib/admin-tabs';
import { logNavigationError } from '../lib/navigation';
import { ApprovalSettingsPage } from './approval-settings';
import { ApprovalsPage } from './approvals';
import { SafetyRulesPage } from './safety-rules';
import { readRouteTab } from './tabbed-route';

export function SecurityPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab = readRouteTab(search.tab, SECURITY_TABS, 'approvals');
  return (
    <TabbedPage
      tabs={SECURITY_TABS}
      activeTab={activeTab}
      onTabChange={(tab) => {
        void navigate({ to: '/admin/security', search: { tab } }).catch(
          logNavigationError,
        );
      }}
    >
      {activeTab === 'approvals' ? (
        <ApprovalSettingsPage />
      ) : activeTab === 'safety' ? (
        <SafetyRulesPage />
      ) : (
        <ApprovalsPage />
      )}
    </TabbedPage>
  );
}
