import { useNavigate, useSearch } from '@tanstack/react-router';
import { TabbedPage } from '../components/tabbed-page';
import { logNavigationError } from '../lib/navigation';
import { SecretsPage } from './secrets';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';
import { TokensPage } from './tokens';

const CREDENTIAL_TABS = [
  { id: 'secrets', label: 'Secrets' },
  { id: 'api-tokens', label: 'API tokens' },
] as const;

type CredentialTab = (typeof CREDENTIAL_TABS)[number]['id'];

export function CredentialsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
  };
  const activeTab = readRouteTab<CredentialTab>(
    search.tab,
    CREDENTIAL_TABS,
    'secrets',
  );

  return (
    <TabbedPage
      tabs={CREDENTIAL_TABS}
      activeTab={activeTab}
      description="Manage stored secrets and scoped API access in one place."
      onTabChange={(tab) => {
        void navigate({
          to: '/admin/credentials',
          search: mergeRouteSearch(search, { tab }),
          replace: true,
        }).catch(logNavigationError);
      }}
    >
      {activeTab === 'api-tokens' ? (
        <TokensPage embedded />
      ) : (
        <SecretsPage embedded />
      )}
    </TabbedPage>
  );
}
