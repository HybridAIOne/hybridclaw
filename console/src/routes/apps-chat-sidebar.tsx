import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { fetchChatRecent } from '../api/chat';
import type { ChatRecentSession } from '../api/chat-types';
import { deleteSession } from '../api/client';
import { isAuthReadyForApi, useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { useToast } from '../components/toast';
import { readStoredUserId } from '../lib/chat-helpers';
import { CHAT_UI_CONFIG } from '../lib/chat-ui-config';
import { getErrorMessage } from '../lib/error-message';
import { ChatSidebarPanel } from './chat/chat-sidebar';

/**
 * The chat recents sidebar, wired for the Apps page. It reuses the chat
 * conversation list so the left rail is continuous between /chat and /apps;
 * opening a conversation or starting a new one navigates back into chat.
 */
export function AppsChatSidebar() {
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = useRef(readStoredUserId()).current;

  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'user' | 'all'>('user');
  const [deleteTarget, setDeleteTarget] = useState<ChatRecentSession | null>(
    null,
  );
  const trimmed = search.trim();

  const recentQuery = useQuery({
    queryKey: ['apps-chat-recent', auth.token, userId, trimmed, scope],
    queryFn: () =>
      fetchChatRecent(
        auth.token,
        userId,
        'web',
        trimmed
          ? CHAT_UI_CONFIG.maxSearchResults
          : CHAT_UI_CONFIG.maxRecentSessions,
        trimmed || undefined,
        scope,
      ),
    staleTime: 10_000,
    enabled: isAuthReadyForApi(auth),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSession(auth.token, id),
    onSuccess: async () => {
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['apps-chat-recent'] });
      toast.success('Conversation deleted.');
    },
    onError: (error) => {
      toast.error(`Delete failed: ${getErrorMessage(error)}`);
    },
  });

  return (
    <>
      <ChatSidebarPanel
        sessions={recentQuery.data?.sessions ?? []}
        activeSessionId=""
        onNewChat={() => navigate({ to: '/chat' })}
        onOpenSession={(sessionId) =>
          navigate({ to: '/chat/$sessionId', params: { sessionId } })
        }
        onRequestDeleteSession={(session) => setDeleteTarget(session)}
        deleteDisabled={deleteMutation.isPending}
        searchQuery={search}
        onSearchQueryChange={setSearch}
        recentScope={scope}
        onRecentScopeChange={setScope}
        isLoading={recentQuery.isFetching}
        onRefreshRecent={() => {
          void recentQuery.refetch();
        }}
      />
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Delete conversation?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.title || 'Untitled'}” will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.sessionId)
              }
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
