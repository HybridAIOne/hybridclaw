import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { PageHeader, Panel } from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { auditQueryOptions } from '../queries';

function prettifyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

export function AuditPage() {
  const auth = useAuth();
  const [query, setQuery] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [eventType, setEventType] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const deferredQuery = useDeferredValue(query);
  const deferredSessionId = useDeferredValue(sessionId);
  const deferredEventType = useDeferredValue(eventType);

  const auditQuery = useQuery(
    auditQueryOptions(auth.token, {
      query: deferredQuery,
      sessionId: deferredSessionId,
      eventType: deferredEventType,
    }),
  );

  const selectedEntry =
    auditQuery.data?.entries.find((entry) => entry.id === selectedId) ||
    auditQuery.data?.entries[0] ||
    null;

  useEffect(() => {
    if (!selectedEntry) return;
    if (selectedEntry.id !== selectedId) {
      setSelectedId(selectedEntry.id);
    }
  }, [selectedEntry, selectedId]);

  return (
    <div className="page-stack">
      <PageHeader title="Audit Log" />

      <Panel title="Filters">
        <div className="field-grid">
          <label className="field">
            <span>Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="approval, tool, error"
            />
          </label>
          <label className="field">
            <span>Session ID</span>
            <input
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="web:default"
            />
          </label>
        </div>
        <label className="field">
          <span>Event type</span>
          <input
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            placeholder="approval.response"
          />
        </label>
      </Panel>

      <div className="two-column-grid">
        <Panel
          title="Entries"
          subtitle={`${auditQuery.data?.entries.length || 0} matching event${auditQuery.data?.entries.length === 1 ? '' : 's'}`}
        >
          {auditQuery.isLoading ? (
            <div className="empty-state">Loading audit entries...</div>
          ) : auditQuery.data?.entries.length ? (
            <div className="list-stack selectable-list">
              {auditQuery.data.entries.map((entry) => (
                <button
                  key={entry.id}
                  className={
                    entry.id === selectedEntry?.id
                      ? 'selectable-row active'
                      : 'selectable-row'
                  }
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                >
                  <div>
                    <strong>{entry.eventType}</strong>
                    <small>
                      {entry.sessionId} · {formatRelativeTime(entry.timestamp)}
                    </small>
                  </div>
                  <span>#{entry.id}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              No audit entries match these filters.
            </div>
          )}
        </Panel>

        <Panel title="Inspection" accent="warm">
          {!selectedEntry ? (
            <div className="empty-state">
              Select an audit event to inspect it.
            </div>
          ) : (
            <div className="detail-stack">
              <div className="key-value-grid">
                <div>
                  <span>Event type</span>
                  <strong>{selectedEntry.eventType}</strong>
                </div>
                <div>
                  <span>Session</span>
                  <strong>{selectedEntry.sessionId}</strong>
                </div>
                <div>
                  <span>Timestamp</span>
                  <strong>{formatDateTime(selectedEntry.timestamp)}</strong>
                </div>
                <div>
                  <span>Run ID</span>
                  <strong>{selectedEntry.runId}</strong>
                </div>
                <div>
                  <span>Seq</span>
                  <strong>{selectedEntry.seq}</strong>
                </div>
                <div>
                  <span>Parent run</span>
                  <strong>{selectedEntry.parentRunId || 'none'}</strong>
                </div>
              </div>
              <div className="summary-block">
                <span>Payload</span>
                <pre className="payload-block">
                  {prettifyPayload(selectedEntry.payload)}
                </pre>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
