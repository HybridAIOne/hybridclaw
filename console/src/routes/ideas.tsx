/**
 * Ideas page (`/chat/ideas`) — five suggestions for what the selected agent
 * could help with, generated server-side from the agent's persona files and
 * this user's recent chats with it.
 *
 * Picking an idea only prefills the chat composer; the user still sends it.
 * Results are cached per agent for the page's lifetime and regenerated only
 * on an explicit refresh, because each generation is a model call.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { fetchChatIdeas } from '../api/chat';
import { fetchAgentList } from '../api/client';
import { isAuthReadyForApi, useAuth } from '../auth';
import { Lightbulb } from '../components/icons';
import { NativeSelect } from '../components/native-select';
import { MobileTopbarTrigger } from '../components/sidebar/index';
import { Skeleton } from '../components/skeleton';
import { readStoredUserId } from '../lib/chat-helpers';
import { getErrorMessage } from '../lib/error-message';
import styles from './apps.module.css';
import { AppsChatSidebar } from './apps-chat-sidebar';
import { RefreshIcon } from './apps-icons';
import chatCss from './chat/chat-page.module.css';
import { ChatSidebarProvider } from './chat/chat-sidebar';
import ideasCss from './ideas.module.css';

const IDEA_SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e'] as const;

export function IdeasPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const userId = useRef(readStoredUserId()).current;
  const search = useSearch({ strict: false }) as { agent?: string };
  const [agentId, setAgentId] = useState(search.agent?.toLowerCase() ?? '');
  const apiReady = isAuthReadyForApi(auth);

  const agentsQuery = useQuery({
    queryKey: ['agents-list', auth.token],
    queryFn: () => fetchAgentList(auth.token),
    staleTime: 30_000,
    enabled: apiReady,
  });
  const localAgents = (agentsQuery.data ?? []).filter(
    (agent) => agent.source?.type !== 'remote',
  );

  const ideasQuery = useQuery({
    queryKey: ['chat-ideas', auth.token, userId, agentId],
    queryFn: () => fetchChatIdeas(auth.token, userId, agentId || undefined),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: apiReady,
  });
  const resolvedAgentId = ideasQuery.data?.agentId ?? agentId;
  const showSkeleton =
    ideasQuery.isFetching || (!ideasQuery.data && !ideasQuery.isError);

  const openIdea = (prompt: string) => {
    void navigate({
      to: '/chat',
      search: {
        prompt,
        ...(resolvedAgentId ? { agent: resolvedAgentId } : {}),
      },
    });
  };

  return (
    <ChatSidebarProvider>
      <div className={chatCss.chatPage}>
        <AppsChatSidebar />
        <div className={chatCss.chatMain}>
          <div className={styles.scroll}>
            <div className={styles.page}>
              <header className={styles.topbar}>
                <div className={styles.topbarLeft}>
                  <MobileTopbarTrigger className={styles.mobileTrigger} />
                  <h1 className={styles.title}>Ideas</h1>
                </div>
                <div className={ideasCss.controls}>
                  {localAgents.length > 1 ? (
                    <NativeSelect
                      size="sm"
                      aria-label="Agent"
                      value={resolvedAgentId}
                      onChange={(event) => setAgentId(event.target.value)}
                    >
                      {localAgents.map((agent) => (
                        <option key={agent.id} value={agent.id.toLowerCase()}>
                          {agent.name || agent.id}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : null}
                  <button
                    type="button"
                    className={ideasCss.refresh}
                    onClick={() => void ideasQuery.refetch()}
                    disabled={ideasQuery.isFetching}
                  >
                    <RefreshIcon aria-hidden="true" />
                    <span>
                      {ideasQuery.isFetching ? 'Thinking…' : 'New ideas'}
                    </span>
                  </button>
                </div>
              </header>
              <p className={ideasCss.lede}>
                Suggestions based on your recent chats and what this agent knows
                about you. Pick one to start a conversation.
              </p>

              {ideasQuery.isError && !showSkeleton ? (
                <div className={ideasCss.error} role="alert">
                  {getErrorMessage(ideasQuery.error)}
                </div>
              ) : null}

              <ul className={ideasCss.list} aria-busy={ideasQuery.isFetching}>
                {showSkeleton
                  ? IDEA_SKELETON_KEYS.map((key) => (
                      <li key={key}>
                        <Skeleton className={ideasCss.skeleton} />
                      </li>
                    ))
                  : (ideasQuery.data?.ideas ?? []).map((idea) => (
                      <li key={`${idea.title}-${idea.prompt}`}>
                        <button
                          type="button"
                          className={ideasCss.idea}
                          onClick={() => openIdea(idea.prompt)}
                        >
                          <span className={ideasCss.ideaGlyph}>
                            <Lightbulb aria-hidden="true" />
                          </span>
                          <span className={ideasCss.ideaBody}>
                            <span className={ideasCss.ideaTitle}>
                              {idea.title}
                            </span>
                            {idea.description ? (
                              <span className={ideasCss.ideaDescription}>
                                {idea.description}
                              </span>
                            ) : null}
                            <span className={ideasCss.ideaPrompt}>
                              “{idea.prompt}”
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </ChatSidebarProvider>
  );
}
