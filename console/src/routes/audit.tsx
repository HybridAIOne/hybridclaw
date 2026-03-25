import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { fetchAudit } from '../api/client';
import { useAuth } from '../auth';
import {
  EmptyState,
  FormField,
  KeyValueGrid,
  KeyValueItem,
  PageHeader,
  Panel,
  SelectableRow,
} from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

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

  const auditQuery = useQuery({
    queryKey: [
      'audit',
      auth.token,
      deferredQuery,
      deferredSessionId,
      deferredEventType,
    ],
    queryFn: () =>
      fetchAudit(auth.token, {
        query: deferredQuery,
        sessionId: deferredSessionId,
        eventType: deferredEventType,
        limit: 100,
      }),
  });

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
          <FormField label="Search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="approval, tool, error"
            />
          </FormField>
          <FormField label="Session ID">
            <input
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="web:default"
            />
          </FormField>
        </div>
        <FormField label="Event type">
          <input
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            placeholder="approval.response"
          />
        </FormField>
      </Panel>

      <div className="two-column-grid">
        <Panel
          title="Entries"
          subtitle={`${auditQuery.data?.entries.length || 0} matching event${auditQuery.data?.entries.length === 1 ? '' : 's'}`}
        >
          {auditQuery.isLoading ? (
            <EmptyState>Loading audit entries...</EmptyState>
          ) : auditQuery.data?.entries.length ? (
            <div className="list-stack selectable-list">
              {auditQuery.data.entries.map((entry) => (
                <SelectableRow
                  key={entry.id}
                  active={entry.id === selectedEntry?.id}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <div>
                    <strong>{entry.eventType}</strong>
                    <small>
                      {entry.sessionId} · {formatRelativeTime(entry.timestamp)}
                    </small>
                  </div>
                  <span>#{entry.id}</span>
                </SelectableRow>
              ))}
            </div>
          ) : (
            <EmptyState>No audit entries match these filters.</EmptyState>
          )}
        </Panel>

        <Panel title="Inspection" accent="warm">
          {!selectedEntry ? (
            <EmptyState>Select an audit event to inspect it.</EmptyState>
          ) : (
            <div className="detail-stack">
              <KeyValueGrid>
                <KeyValueItem
                  label="Event type"
                  value={selectedEntry.eventType}
                />
                <KeyValueItem
                  label="Session"
                  value={selectedEntry.sessionId}
                />
                <KeyValueItem
                  label="Timestamp"
                  value={formatDateTime(selectedEntry.timestamp)}
                />
                <KeyValueItem label="Run ID" value={selectedEntry.runId} />
                <KeyValueItem label="Seq" value={selectedEntry.seq} />
                <KeyValueItem
                  label="Parent run"
                  value={selectedEntry.parentRunId || 'none'}
                />
              </KeyValueGrid>
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
