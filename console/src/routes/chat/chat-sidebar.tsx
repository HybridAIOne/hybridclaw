import type { ChatRecentSession } from '../../api/chat-types';
import { cx } from '../../lib/cx';
import { formatRelativeTime } from '../../lib/format';
import css from './chat-page.module.css';

export function ChatSidebar(props: {
  sessions: ChatRecentSession[];
  activeSessionId: string;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onHoverSession?: (sessionId: string) => void;
  isPending?: boolean;
}) {
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
        + New Conversation
      </button>
      {props.sessions.length > 0 ? (
        <>
          <div className={css.sidebarLabel}>Recent</div>
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
                  onKeyDown={(e) => {
                    if (e.key === ' ') {
                      e.preventDefault();
                      props.onOpenSession(s.sessionId);
                    }
                  }}
                >
                  <span className={css.sessionTitle}>
                    {s.title || 'Untitled'}
                  </span>
                  <span className={css.sessionTime}>
                    {formatRelativeTime(s.lastActive)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
