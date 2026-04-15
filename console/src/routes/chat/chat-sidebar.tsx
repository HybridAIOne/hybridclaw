import type { ReactNode } from 'react';
import type { ChatRecentSession } from '../../api/chat-types';
import { HybridClaw, PanelLeft } from '../../components/icons';
import {
  getSidebarStyleVars,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  useSidebar,
} from '../../components/sidebar/index';
import { cx } from '../../lib/cx';
import { formatRelativeTime } from '../../lib/format';
import css from './chat-page.module.css';

const CHAT_SIDEBAR_STYLE = {
  ...getSidebarStyleVars('260px', '280px'),
  '--sidebar-width-icon': '0px',
} as React.CSSProperties;

export interface ChatSidebarProps {
  sessions: ChatRecentSession[];
  activeSessionId: string;
  onNewChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onHoverSession?: (sessionId: string) => void;
  isPending?: boolean;
}

export function ChatSidebarProvider(props: { children: ReactNode }) {
  return (
    <SidebarProvider style={CHAT_SIDEBAR_STYLE} defaultOpen storageKey={false}>
      {props.children}
    </SidebarProvider>
  );
}

export function ChatSidebarPanel(props: ChatSidebarProps) {
  return (
    <Sidebar side="left">
      <SidebarHeader>
        <ChatSidebarHeader />
      </SidebarHeader>
      <SidebarContent>
        <ChatSessionList {...props} />
      </SidebarContent>
    </Sidebar>
  );
}

export { SidebarTrigger as ChatSidebarTrigger } from '../../components/sidebar/index';

function ChatSidebarHeader() {
  const { toggleSidebar } = useSidebar();

  return (
    <div className={css.chatSidebarHeader}>
      <div className={css.chatSidebarBrand}>
        <HybridClaw className={css.sidebarLogo} />
        <span className={css.sidebarBrand}>HybridClaw</span>
      </div>
      <button
        type="button"
        className={css.headerButton}
        onClick={toggleSidebar}
        aria-label="Toggle sessions"
        title="Toggle sessions"
      >
        <PanelLeft />
      </button>
    </div>
  );
}

function ChatSessionList(props: ChatSidebarProps) {
  return (
    <div className={css.chatSidebarContent}>
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
    </div>
  );
}
