/**
 * Ideas page (`/chat/ideas`) — five suggestions for what the selected agent
 * could help with, generated server-side from the agent's persona files and
 * this user's recent chats with it.
 *
 * Picking an idea only prefills the chat composer; the user still sends it.
 * Each generation is a model call, so the last result per user and agent is
 * kept in this browser and replaced only when the user refreshes.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { fetchChatIdeas } from '../api/chat';
import type { ChatIdeasResponse } from '../api/chat-types';
import { fetchAgentList } from '../api/client';
import { isAuthReadyForApi, useAuth } from '../auth';
import { Button } from '../components/button';
import { ChevronRight, Lightbulb } from '../components/icons';
import { NativeSelect } from '../components/native-select';
import { Skeleton } from '../components/skeleton';
import { readStoredUserId } from '../lib/chat-helpers';
import { cx } from '../lib/cx';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import { RefreshIcon } from './apps-icons';
import { ChatSurfacePage } from './chat-surface-page';
import css from './ideas.module.css';

const IDEA_SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e'] as const;
const IDEAS_CACHE_PREFIX = 'hybridclaw.chat-ideas.v1';

function ideasCacheKey(userId: string, agentId: string): string {
  return `${IDEAS_CACHE_PREFIX}:${userId}:${agentId || 'default'}`;
}

function readCachedIdeas(key: string): ChatIdeasResponse | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ChatIdeasResponse>;
    if (
      typeof parsed.agentId !== 'string' ||
      typeof parsed.generatedAt !== 'string' ||
      !Array.isArray(parsed.ideas) ||
      parsed.ideas.length === 0
    ) {
      return undefined;
    }
    return parsed as ChatIdeasResponse;
  } catch {
    return undefined;
  }
}

function writeCachedIdeas(key: string, value: ChatIdeasResponse): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: ideas still show, they just won't survive a reload.
  }
}

export function IdeasPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const userId = useRef(readStoredUserId()).current;
  const search = useSearch({ strict: false }) as { agent?: string };
  const [agentId, setAgentId] = useState(search.agent?.toLowerCase() ?? '');
  const apiReady = isAuthReadyForApi(auth);
  const cacheKey = ideasCacheKey(userId, agentId);

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
    queryFn: async () => {
      const result = await fetchChatIdeas(
        auth.token,
        userId,
        agentId || undefined,
      );
      writeCachedIdeas(cacheKey, result);
      return result;
    },
    initialData: () => readCachedIdeas(cacheKey),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: apiReady,
  });

  const data = ideasQuery.data;
  const resolvedAgentId = data?.agentId ?? agentId;
  const agentName =
    localAgents.find((agent) => agent.id.toLowerCase() === resolvedAgentId)
      ?.name || 'your agent';
  const generating = ideasQuery.isFetching;

  const openIdea = (prompt: string) => {
    void navigate({
      to: '/chat',
      search: {
        prompt,
        ...(resolvedAgentId ? { agent: resolvedAgentId } : {}),
      },
    });
  };

  const refreshButton = (
    <button
      type="button"
      className={css.refresh}
      onClick={() => void ideasQuery.refetch()}
      disabled={generating}
    >
      <RefreshIcon
        aria-hidden="true"
        className={cx(generating && css.spinning)}
      />
      <span>{generating ? 'Generating…' : 'Refresh ideas'}</span>
    </button>
  );

  const agentPicker =
    localAgents.length > 1 ? (
      <NativeSelect
        size="sm"
        aria-label="Agent"
        className={css.agentSelect}
        value={resolvedAgentId}
        onChange={(event) => setAgentId(event.target.value)}
      >
        {localAgents.map((agent) => (
          <option key={agent.id} value={agent.id.toLowerCase()}>
            {agent.name || agent.id}
          </option>
        ))}
      </NativeSelect>
    ) : null;

  const subtitle = generating
    ? data
      ? `Coming up with new ideas from your recent chats with ${agentName}…`
      : `Looking through your recent chats with ${agentName}. This can take a minute.`
    : data
      ? `What ${agentName} can take on next, from your recent chats. Updated ${formatRelativeTime(data.generatedAt)}.`
      : `What ${agentName} can take on next, based on your recent chats.`;

  return (
    <ChatSurfacePage
      page="ideas"
      title="Ideas"
      subtitle={<span aria-live="polite">{subtitle}</span>}
      actions={
        <>
          {agentPicker}
          {refreshButton}
        </>
      }
    >
      {ideasQuery.isError && !generating ? (
        <div className={css.error} role="alert">
          <span>
            {data ? 'Could not refresh ideas: ' : 'Could not generate ideas: '}
            {getErrorMessage(ideasQuery.error)}
          </span>
          {data ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void ideasQuery.refetch()}
            >
              Try again
            </Button>
          )}
        </div>
      ) : null}

      {data ? (
        <ul
          className={cx(css.list, generating && css.listStale)}
          aria-busy={generating}
        >
          {data.ideas.map((idea) => (
            <li key={`${idea.title}-${idea.prompt}`}>
              <button
                type="button"
                className={css.idea}
                onClick={() => openIdea(idea.prompt)}
                disabled={generating}
              >
                <span className={css.ideaIcon} aria-hidden="true">
                  {idea.emoji || <Lightbulb />}
                </span>
                <span className={css.ideaText}>
                  <span className={css.ideaTitle}>{idea.title}</span>
                  {idea.description ? (
                    <span className={css.ideaDescription}>
                      {idea.description}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className={css.ideaChevron} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : generating ? (
        <ul className={css.list} aria-busy="true">
          {IDEA_SKELETON_KEYS.map((key) => (
            <li key={key} className={css.skeletonRow}>
              <Skeleton className={css.skeletonIcon} />
              <span className={css.skeletonText}>
                <Skeleton className={css.skeletonTitle} />
                <Skeleton className={css.skeletonLine} />
                <Skeleton className={css.skeletonLineShort} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </ChatSurfacePage>
  );
}
