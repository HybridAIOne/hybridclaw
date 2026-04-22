import type { ReactNode } from 'react';
import { useAuth } from '../../auth';
import type { ChatRecentSession } from '../../api/chat-types';
import { HybridClaw } from '../../components/icons';
import {
  getSidebarStyleVars,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
} from '../../components/sidebar/index';
import sidebarStyles from '../../components/sidebar/index.module.css';
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
  const auth = useAuth();
  const isSearching = props.searchQuery.trim().length > 0;
  return (
    <Sidebar side="left" collapsible="icon">
      <SidebarHeader>
        <div className={sidebarStyles.headerRow}>
          <div className={sidebarStyles.brand}>
            <div className={sidebarStyles.brandTitle}>
              <span className={sidebarStyles.brandMark} aria-hidden="true">
                <HybridClaw />
              </span>
              <div className={sidebarStyles.brandText}>
                <h1>HybridClaw</h1>
              </div>
            </div>
          </div>
          <SidebarTrigger className={css.sidebarCollapseButton} />
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
        {auth.gatewayStatus?.version ? (
          <div className={css.sidebarVersion}>
            HybridClaw v.{auth.gatewayStatus.version}
          </div>
        ) : null}
      </SidebarFooter>
    </Sidebar>
  );
}

function ChatSessionList(props: ChatSidebarProps & { isSearching: boolean }) {
  return (
    <div className={css.chatSidebarContent}>
      <div className={css.sidebarLabel}>
        {props.isSearching ? 'Search Results' : 'Recent Chats'}
      </div>
      {renderSessionListBody(props)}
    </div>
  );
}

function renderSessionListBody(
  props: ChatSidebarProps & { isSearching: boolean },
) {
  if (props.isLoading && props.isSearching) {
    return <div className={css.sidebarStatus}>Searching...</div>;
  }
  if (props.sessions.length === 0) {
    return (
      <div className={css.sidebarStatus}>
        {props.isSearching
          ? 'No matching conversations.'
          : 'No recent chats yet.'}
      </div>
    );
  }
  return (
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
  );
}
