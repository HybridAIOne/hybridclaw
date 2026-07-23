import { useNavigate, useSearch } from '@tanstack/react-router';
import { TabbedPage } from '../components/tabbed-page';
import { EXTENSION_TABS } from '../lib/admin-tabs';
import { logNavigationError } from '../lib/navigation';
import { PluginsPage } from './plugins';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';
import { ToolsPage } from './tools';

type ExtensionTab = (typeof EXTENSION_TABS)[number]['id'];

export function ExtensionsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
  };
  const activeTab = readRouteTab<ExtensionTab>(
    search.tab,
    EXTENSION_TABS,
    'plugins',
  );

  return (
    <TabbedPage
      tabs={EXTENSION_TABS}
      activeTab={activeTab}
      onTabChange={(tab) => {
        void navigate({
          to: '/admin/extensions',
          search: mergeRouteSearch(search, { tab }),
          replace: true,
        }).catch(logNavigationError);
      }}
    >
      {activeTab === 'tools' ? (
        <ToolsPage embedded />
      ) : (
        <PluginsPage embedded />
      )}
    </TabbedPage>
  );
}
