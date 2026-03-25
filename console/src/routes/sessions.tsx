import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { deleteSession, fetchSessions } from '../api/client';
import { useAuth } from '../auth';
import {
  Banner,
  BooleanPill,
  Button,
  EmptyState,
  KeyValueGrid,
  KeyValueItem,
  PageHeader,
  Panel,
  SelectableRow,
} from '../components/ui';
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
            <EmptyState>Loading sessions...</EmptyState>
          ) : filtered.length === 0 ? (
            <EmptyState>No sessions match this filter.</EmptyState>
          ) : (
            <div className="list-stack selectable-list">
              {filtered.map((session) => (
                <SelectableRow
                  key={session.id}
                  active={session.id === selectedSession?.id}
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
                </SelectableRow>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Inspection" accent="warm">
          {!selectedSession ? (
            <EmptyState>Select a session to inspect it.</EmptyState>
          ) : (
            <div className="detail-stack">
              <KeyValueGrid>
                <KeyValueItem
                  label="Session"
                  value={selectedSession.id}
                />
                <KeyValueItem
                  label="Channel"
                  value={selectedSession.channelId}
                />
                <KeyValueItem
                  label="Guild"
                  value={selectedSession.guildId || 'direct/web'}
                />
                <KeyValueItem
                  label="Model"
                  value={selectedSession.effectiveModel}
                />
                <KeyValueItem
                  label="Messages"
                  value={selectedSession.messageCount}
                />
                <KeyValueItem
                  label="Scheduled tasks"
                  value={selectedSession.taskCount}
                />
                <KeyValueItem
                  label="RAG"
                  value={
                    <BooleanPill
                      value={selectedSession.ragEnabled}
                      trueLabel="on"
                      falseLabel="off"
                    />
                  }
                />
                <KeyValueItem
                  label="Last active"
                  value={formatRelativeTime(selectedSession.lastActive)}
                />
              </KeyValueGrid>
              <div className="summary-block">
                <span>Summary</span>
                <p>
                  {selectedSession.summary ||
                    'No summary stored for this session.'}
                </p>
              </div>
              <Button
                variant="danger"
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
              </Button>
              {deleteMutation.isSuccess ? (
                <Banner variant="success">
                  Removed {deleteMutation.data.deletedMessages} messages and{' '}
                  {deleteMutation.data.deletedTasks} tasks.
                </Banner>
              ) : null}
              {deleteMutation.isError ? (
                <Banner variant="error">
                  {(deleteMutation.error as Error).message}
                </Banner>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
