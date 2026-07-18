import type { ReactNode } from 'react';
import { PageHeader } from './ui';

export interface PageTab<TabId extends string> {
  id: TabId;
  label: string;
}

export function TabbedPage<TabId extends string>(props: {
  tabs: ReadonlyArray<PageTab<TabId>>;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const activeTab =
    props.tabs.find((tab) => tab.id === props.activeTab) || props.tabs[0];

  if (!activeTab) return null;

  return (
    <div className="page-stack tabbed-page">
      <PageHeader description={props.description} actions={props.actions} />
      <div className="page-tabs" role="tablist" aria-label="Page sections">
        {props.tabs.map((tab) => {
          const active = tab.id === activeTab.id;
          return (
            <button
              id={`page-tab-${tab.id}`}
              key={tab.id}
              className={active ? 'page-tab is-active' : 'page-tab'}
              type="button"
              role="tab"
              aria-controls={`page-panel-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => props.onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={`page-panel-${activeTab.id}`}
        className="page-tab-panel"
        role="tabpanel"
        aria-labelledby={`page-tab-${activeTab.id}`}
      >
        {props.children}
      </div>
    </div>
  );
}
