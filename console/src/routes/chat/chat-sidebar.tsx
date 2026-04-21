import type { ReactNode } from 'react';
import type { ChatRecentSession } from '../../api/chat-types';
import { Button } from '../../components/button';
import { SquarePen } from '../../components/icons';
import {
  getSidebarStyleVars,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
} from '../../components/sidebar/index';
import { cx } from '../../lib/cx';
import { formatRelativeTime } from '../../lib/format';
import css from './chat-page.module.css';

const CHAT_SIDEBAR_STYLE = getSidebarStyleVars('260px', '280px');

export interface ChatSidebarProps {
  sessions: ChatRecentSession[];
  activeSessionId: string;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onHoverSession?: (sessionId: string) => void;
  isPending?: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  isLoading: boolean;
}

export function ChatSidebarProvider(props: { children: ReactNode }) {
  return (
    <SidebarProvider style={CHAT_SIDEBAR_STYLE} defaultOpen storageKey={false}>
      {props.children}
    </SidebarProvider>
  );
}

export function ChatSidebarPanel(props: ChatSidebarProps) {
  const isSearching = props.searchQuery.trim().length > 0;
  return (
    <Sidebar side="left" collapsible="none">
      <SidebarHeader>
        <div className={css.chatSidebarHeader}>
          <span className={css.sidebarLabel} style={{ margin: 0 }}>
            Sessions
          </span>
          <Button
            variant="outline"
            size="icon"
            className={css.newChatButton}
            onClick={props.onNewChat}
            aria-label="New conversation"
            title="New conversation"
          >
            <SquarePen />
          </Button>
        </div>
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
    </Sidebar>
  );
}

function ChatSessionList(props: ChatSidebarProps & { isSearching: boolean }) {
  if (props.isLoading && props.isSearching) {
    return (
      <div className={css.chatSidebarContent}>
        <div className={css.sidebarStatus}>Searching...</div>
      </div>
    );
  }
  if (props.sessions.length === 0) {
    return props.isSearching ? (
      <div className={css.chatSidebarContent}>
        <div className={css.sidebarStatus}>No matching conversations.</div>
      </div>
    ) : null;
  }
  return (
    <div className={css.chatSidebarContent}>
      <div className={css.sidebarLabel}>
        {props.isSearching ? 'Search Results' : 'Recent'}
      </div>
      <ul className={css.sessionList} aria-live="polite">
        {props.sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              type="button"
              className={cx(
                css.sessionItem,
                s.sessionId === props.activeSessionId && css.sessionItemActive,
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
              <span className={css.sessionTitle}>{s.title || 'Untitled'}</span>
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
    </div>
  );
}
