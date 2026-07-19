import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { deleteSession, fetchSessions } from '../api/client';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { TabbedPageActions } from '../components/tabbed-page';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import { logNavigationError } from '../lib/navigation';

export function SessionsPage(
  props: { rangeDays?: number; embedded?: boolean } = {},
) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const sessionsSearch = useSearch({ strict: false }) as Record<
    string,
    unknown
  > & { sessionId?: string };
  const requestedSessionId = sessionsSearch.sessionId?.trim() || null;
  const lastRequestedSessionId = useRef(requestedSessionId);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(
    () => requestedSessionId,
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const sessionsQuery = useQuery({
    queryKey: ['sessions', auth.token],
    queryFn: () => fetchSessions(auth.token),
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteSession(auth.token, sessionId),
    onSuccess: (data, sessionId) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(
        'Session deleted',
        `Removed ${data.deletedMessages} messages and ${data.deletedTasks} tasks.`,
      );
      if (selectedId === sessionId) {
        setSelectedId(null);
        void navigate({
          to: props.embedded ? '/admin/activity' : '/admin/sessions',
          replace: true,
          search: props.embedded
            ? { ...sessionsSearch, tab: 'sessions', sessionId: undefined }
            : { sessionId: undefined },
        }).catch(logNavigationError);
      }
    },
    onError: (error) => {
      toast.error('Delete failed', getErrorMessage(error));
    },
  });

  const rangeCutoff = props.rangeDays
    ? Date.now() - props.rangeDays * 24 * 60 * 60 * 1000
    : null;
  const filtered = (sessionsQuery.data || []).filter((session) => {
    if (rangeCutoff !== null) {
      const lastActive = Date.parse(session.lastActive);
      if (Number.isFinite(lastActive) && lastActive < rangeCutoff) return false;
    }
    const haystack = [
      session.id,
      session.channelId,
      session.guildId || '',
      session.effectiveModel,
      session.summary || '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(deferredSearch.trim().toLowerCase());
  });

  const selectedSession =
    filtered.find((session) => session.id === selectedId) ||
    filtered[0] ||
    null;

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedId) {
      setSelectedId(selectedSession.id);
    }
  }, [selectedId, selectedSession]);

  useEffect(() => {
    if (requestedSessionId === lastRequestedSessionId.current) return;
    lastRequestedSessionId.current = requestedSessionId;
    if (requestedSessionId && requestedSessionId !== selectedId) {
      setSelectedId(requestedSessionId);
    }
  }, [requestedSessionId, selectedId]);

  function selectSession(sessionId: string): void {
    setSelectedId(sessionId);
    void navigate({
      to: props.embedded ? '/admin/activity' : '/admin/sessions',
      replace: true,
      search: props.embedded
        ? { ...sessionsSearch, tab: 'sessions', sessionId }
        : { sessionId },
    }).catch(logNavigationError);
  }

  return (
    <div className="page-stack">
      {props.embedded ? (
        <TabbedPageActions>
          <input
            className="compact-search page-tab-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by session, channel, model"
            aria-label="Filter sessions"
          />
        </TabbedPageActions>
      ) : (
        <PageHeader
          actions={
            <input
              className="compact-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by session, channel, model"
              aria-label="Filter sessions"
            />
          }
        />
      )}

      <div className="two-column-grid sessions-layout">
        <Card>
          <CardHeader>
            <CardTitle>Session list</CardTitle>
            <CardDescription>
              {`${filtered.length} result${filtered.length === 1 ? '' : 's'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sessionsQuery.isLoading ? (
              <div className="empty-state">Loading sessions...</div>
            ) : filtered.length === 0 ? (
              <div className="empty-state">No sessions match this filter.</div>
            ) : (
              <div className="list-stack selectable-list">
                {filtered.map((session) => (
                  <button
                    key={session.id}
                    className={
                      session.id === selectedSession?.id
                        ? 'selectable-row active'
                        : 'selectable-row'
                    }
                    type="button"
                    onClick={() => selectSession(session.id)}
                  >
                    <div className="session-row-main">
                      <strong>{session.id}</strong>
                      <small className="session-row-meta">
                        {session.channelId} · {session.effectiveModel}
                      </small>
                    </div>
                    <span className="session-row-time">
                      {formatRelativeTime(session.lastActive)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Inspection</CardTitle>
          </CardHeader>
          <CardContent>
            {!selectedSession ? (
              <div className="empty-state">Select a session to inspect it.</div>
            ) : (
              <div className="detail-stack">
                <div className="key-value-grid">
                  <div>
                    <span>Session</span>
                    <strong>{selectedSession.id}</strong>
                  </div>
                  <div>
                    <span>Channel</span>
                    <strong>{selectedSession.channelId}</strong>
                  </div>
                  <div>
                    <span>Guild</span>
                    <strong>{selectedSession.guildId || 'direct/web'}</strong>
                  </div>
                  <div>
                    <span>Model</span>
                    <strong>{selectedSession.effectiveModel}</strong>
                  </div>
                  <div>
                    <span>Messages</span>
                    <strong>{selectedSession.messageCount}</strong>
                  </div>
                  <div>
                    <span>Scheduled tasks</span>
                    <strong>{selectedSession.taskCount}</strong>
                  </div>
                  <div>
                    <span>RAG</span>
                    <BooleanPill
                      value={selectedSession.ragEnabled}
                      trueLabel="on"
                      falseLabel="off"
                    />
                  </div>
                  <div>
                    <span>Last active</span>
                    <strong>
                      {formatRelativeTime(selectedSession.lastActive)}
                    </strong>
                  </div>
                </div>
                <div className="summary-block">
                  <span>Summary</span>
                  <p>
                    {selectedSession.summary ||
                      'No summary stored for this session.'}
                  </p>
                </div>
                <button
                  className="danger-button"
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  {deleteMutation.isPending ? 'Deleting...' : 'Delete session'}
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              This will permanently remove the session and all associated audit
              events.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="ghost-button">Cancel</DialogClose>
            <DialogClose
              className="danger-button"
              onClick={() => {
                if (selectedSession) {
                  deleteMutation.mutate(selectedSession.id);
                }
              }}
            >
              Delete
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
