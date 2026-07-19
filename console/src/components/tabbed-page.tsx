import { createContext, type ReactNode, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { PageHeader } from './ui';

const TabBarActionsContext = createContext<HTMLDivElement | null>(null);

export function TabbedPageActions(props: { children: ReactNode }) {
  const target = useContext(TabBarActionsContext);
  return target ? createPortal(props.children, target) : null;
}

export interface PageTab<TabId extends string> {
  id: TabId;
  label: string;
}

export function TabbedPage<TabId extends string>(props: {
  tabs: ReadonlyArray<PageTab<TabId>>;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [tabBarActionsElement, setTabBarActionsElement] =
    useState<HTMLDivElement | null>(null);
  const activeTab =
    props.tabs.find((tab) => tab.id === props.activeTab) || props.tabs[0];

  if (!activeTab) return null;

  return (
    <TabBarActionsContext.Provider value={tabBarActionsElement}>
      <div className="page-stack tabbed-page">
        <PageHeader actions={props.actions} />
        <div className="page-tabs">
          <div
            className="page-tab-list"
            role="tablist"
            aria-label="Page sections"
          >
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
          <div className="page-tab-actions" ref={setTabBarActionsElement} />
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
    </TabBarActionsContext.Provider>
  );
}
