import type { ChatRecentSession } from '../../api/chat-types';
import { cx } from '../../lib/cx';
import { formatRelativeTime } from '../../lib/format';
import css from './chat-page.module.css';

export function ChatSidebar(props: {
  sessions: ChatRecentSession[];
  activeSessionId: string;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  isLoading: boolean;
}) {
  const trimmedSearch = props.searchQuery.trim();
  const isSearching = trimmedSearch.length > 0;

  return (
    <>
      <div className={css.sidebarHeader}>
        <img
          className={css.sidebarLogo}
          src="/static/hybridclaw-logo.svg"
          alt="HybridClaw"
        />
        <span className={css.sidebarBrand}>HybridClaw</span>
      </div>
      <button
        type="button"
        className={css.newChatButton}
        onClick={props.onNewChat}
      >
        <span className={css.newChatIcon} aria-hidden="true">
          +
        </span>
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
      {props.isLoading && isSearching ? (
        <div className={css.sidebarStatus}>Searching...</div>
      ) : props.sessions.length > 0 ? (
        <>
          <div className={css.sidebarLabel}>
            {isSearching ? 'Search results' : 'Recent chats'}
          </div>
          <ul className={css.sessionList} aria-live="polite">
            {props.sessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  type="button"
                  className={cx(
                    css.sessionItem,
                    s.sessionId === props.activeSessionId &&
                      css.sessionItemActive,
                  )}
                  aria-current={
                    s.sessionId === props.activeSessionId ? 'page' : undefined
                  }
                  onClick={() => props.onOpenSession(s.sessionId)}
                >
                  <span className={css.sessionTitle}>
                    {s.title || 'Untitled'}
                  </span>
                  {s.searchSnippet ? (
                    <span className={css.sessionSnippet}>
                      {s.searchSnippet}
                    </span>
                  ) : null}
                  <span className={css.sessionTime}>
                    {formatRelativeTime(s.lastActive)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : isSearching ? (
        <div className={css.sidebarStatus}>No matching conversations.</div>
      ) : null}
      <div className={css.sidebarSpacer} />
    </>
  );
}
