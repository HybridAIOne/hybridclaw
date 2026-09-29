/**
 * Page frame for the end-user pages that live beside chat (Apps, Ideas): the
 * chat recents sidebar, the same top-right view switch the chat page shows,
 * and a titled header with page actions.
 *
 * Owns layout only; each page keeps its own data, dialogs, and list styling.
 */
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { MobileTopbarTrigger } from '../components/sidebar/index';
import {
  useConfiguredViewSwitchItems,
  ViewSwitchNav,
} from '../components/view-switch';
import { AppsChatSidebar } from './apps-chat-sidebar';
import chatCss from './chat/chat-page.module.css';
import {
  ChatSidebarProvider,
  type ChatSurfacePageId,
} from './chat/chat-sidebar';
import css from './chat-surface-page.module.css';

export function ChatSurfacePage(props: {
  page: ChatSurfacePageId;
  title: string;
  /** One line under the title saying what the page shows. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Dialogs and other overlays rendered outside the scroll area. */
  overlays?: ReactNode;
}) {
  const auth = useAuth();
  const viewSwitchItems = useConfiguredViewSwitchItems(auth.token);
  return (
    <ChatSidebarProvider>
      <div className={chatCss.chatPage}>
        <AppsChatSidebar activePage={props.page} />
        <div className={chatCss.chatMain}>
          <div className={chatCss.chatTopbar}>
            <MobileTopbarTrigger className={chatCss.chatMobileTrigger} />
            <ViewSwitchNav items={viewSwitchItems} />
          </div>
          <div className={css.scroll}>
            <div className={css.page}>
              <header className={css.header}>
                <div className={css.heading}>
                  <h1 className={css.title}>{props.title}</h1>
                  {props.subtitle ? (
                    <p className={css.subtitle}>{props.subtitle}</p>
                  ) : null}
                </div>
                {props.actions ? (
                  <div className={css.actions}>{props.actions}</div>
                ) : null}
              </header>
              {props.children}
            </div>
          </div>
        </div>
      </div>
      {props.overlays}
    </ChatSidebarProvider>
  );
}
