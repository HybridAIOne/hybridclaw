import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { deleteSession, fetchSessions } from '../api/client';
import { useAuth } from '../auth';
import { BooleanPill, PageHeader, Panel } from '../components/ui';
import { formatRelativeTime } from '../lib/format';

export function SessionsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  const sessionsQuery = useQuery({
    queryKey: ['sessions', auth.token],
    queryFn: () => fetchSessions(auth.token),
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteSession(auth.token, sessionId),
    onSuccess: (_, sessionId) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      if (selectedId === sessionId) {
        setSelectedId(null);
      }
    },
  });

  const filtered = (sessionsQuery.data || []).filter((session) => {
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

  return (
    <div className="page-stack">
      <PageHeader
        title="Sessions"
        actions={
          <input
            className="compact-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by session, channel, model"
          />
        }
      />

      <div className="two-column-grid sessions-layout">
        <Panel
          title="Session list"
          subtitle={`${filtered.length} result${filtered.length === 1 ? '' : 's'}`}
        >
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
                  onClick={() => setSelectedId(session.id)}
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
        </Panel>

        <Panel title="Inspection" accent="warm">
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
                onClick={() => {
                  const confirmed = window.confirm(
                    `Delete session ${selectedSession.id} and all related records?`,
                  );
                  if (!confirmed) return;
                  deleteMutation.mutate(selectedSession.id);
                }}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete session'}
              </button>
              {deleteMutation.isSuccess ? (
                <p className="success-banner">
                  Removed {deleteMutation.data.deletedMessages} messages and{' '}
                  {deleteMutation.data.deletedTasks} tasks.
                </p>
              ) : null}
              {deleteMutation.isError ? (
                <p className="error-banner">
                  {(deleteMutation.error as Error).message}
                </p>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
