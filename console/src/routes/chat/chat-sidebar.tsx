import { useEffect } from 'react';
import type { ChatRecentSession } from '../../api/chat-types';
import { useAuth } from '../../auth';
import {
  SidebarBrand,
  SidebarMeta,
} from '../../components/sidebar/app-sidebar';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
} from '../../components/sidebar/index';
import sidebarStyles from '../../components/sidebar/index.module.css';
import { ThemeToggle } from '../../components/theme-toggle';
import { cx } from '../../lib/cx';
import { formatRelativeTime } from '../../lib/format';
import css from './chat-page.module.css';

export { SidebarProvider as ChatSidebarProvider } from '../../components/sidebar/index';

export interface ChatSidebarProps {
  sessions: ChatRecentSession[];
  activeSessionId: string;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onHoverSession?: (sessionId: string) => void;
  isPending?: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  recentScope: 'user' | 'all';
  onRecentScopeChange: (scope: 'user' | 'all') => void;
  isLoading: boolean;
  onRefreshRecent?: () => void;
}

export function ChatSidebarPanel(props: ChatSidebarProps) {
  const auth = useAuth();
  const sidebar = useSidebar();
  const isSearching = props.searchQuery.trim().length > 0;

  useEffect(() => {
    if (!sidebar.openMobile) return;
    props.onRefreshRecent?.();
  }, [props.onRefreshRecent, sidebar.openMobile]);

  return (
    <Sidebar side="left" collapsible="icon">
      <SidebarHeader>
        <div className={sidebarStyles.headerRow}>
          <SidebarBrand />
          <SidebarTrigger className={sidebarStyles.sidebarToggle} />
        </div>
        <button
          type="button"
          className={css.newChatButton}
          onClick={props.onNewChat}
        >
          <span aria-hidden="true">+</span>
          <span>New Conversation</span>
        </button>
        <div className={css.sidebarSearchWrap}>
          <input
            type="search"
            className={css.sidebarSearch}
            value={props.searchQuery}
            onChange={(event) => props.onSearchQueryChange(event.target.value)}
            placeholder="Search"
            aria-label="Search conversations"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <ChatSessionList {...props} isSearching={isSearching} />
      </SidebarContent>
      <SidebarFooter>
        <div className={sidebarStyles.footerBlock}>
          <SidebarMeta version={auth.gatewayStatus?.version} />
          <ThemeToggle labelClassName={sidebarStyles.themeToggleLabel} />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function ChatSessionList(props: ChatSidebarProps & { isSearching: boolean }) {
  return (
    <div className={css.chatSidebarContent}>
      <div className={css.sidebarListHeader}>
        <div className={css.sidebarLabel}>
          {props.isSearching ? 'Search Results' : 'Recent Chats'}
        </div>
        <div className={css.sidebarScopeToggle}>
          {(['user', 'all'] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={cx(
                css.sidebarScopeButton,
                props.recentScope === scope && css.sidebarScopeButtonActive,
              )}
              aria-pressed={props.recentScope === scope}
              onClick={() => props.onRecentScopeChange(scope)}
            >
              {scope === 'user' ? 'User' : 'All'}
            </button>
          ))}
        </div>
      </div>
      {props.isLoading && props.isSearching ? (
        <div className={css.sidebarStatus}>Searching...</div>
      ) : props.sessions.length === 0 ? (
        <div className={css.sidebarStatus}>
          {props.isSearching
            ? 'No matching conversations.'
            : 'No recent chats yet.'}
        </div>
      ) : (
        <ul className={css.sessionList} aria-live="polite">
          {props.sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                className={cx(
                  css.sessionItem,
                  s.sessionId === props.activeSessionId &&
                    css.sessionItemActive,
                  s.sessionId === props.activeSessionId &&
                    props.isPending &&
                    css.sessionItemPending,
                )}
                aria-current={
                  s.sessionId === props.activeSessionId ? 'page' : undefined
                }
                onMouseEnter={() => props.onHoverSession?.(s.sessionId)}
                onClick={() => props.onOpenSession(s.sessionId)}
              >
                <span className={css.sessionTitle}>
                  {s.title || 'Untitled'}
                </span>
                {s.searchSnippet ? (
                  <span className={css.sessionSnippet}>{s.searchSnippet}</span>
                ) : null}
                <span className={css.sessionTime}>
                  {formatRelativeTime(s.lastActive)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
