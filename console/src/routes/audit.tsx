import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useDeferredValue, useState } from 'react';
import { fetchAudit } from '../api/client';
import type { AdminAuditEntry } from '../api/types';
import { useAuth } from '../auth';
import { Input } from '../components/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../components/sheet';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import styles from './audit.module.css';

const KNOWN_CATEGORIES = new Set([
  'session',
  'turn',
  'model',
  'tool',
  'autonomy',
  'authorization',
  'approval',
  'a2a',
]);

function categorize(eventType: string): string {
  const prefix = eventType.split('.', 1)[0] || '';
  return KNOWN_CATEGORIES.has(prefix) ? prefix : 'default';
}

function prettifyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

function formatTime(timestamp: string): { relative: string; absolute: string } {
  return {
    relative: formatRelativeTime(timestamp),
    absolute: formatDateTime(timestamp),
  };
}

export function AuditPage() {
  const auth = useAuth();
  const [query, setQuery] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [eventType, setEventType] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  const entries = auditQuery.data?.entries ?? [];
  const selectedEntry =
    entries.find((entry) => entry.id === selectedId) ?? null;
  const hasFilter = Boolean(query || sessionId || eventType);

  function openEntry(entry: AdminAuditEntry): void {
    setSelectedId(entry.id);
    setDrawerOpen(true);
  }

  function handleRowKeyDown(
    event: KeyboardEvent<HTMLTableRowElement>,
    entry: AdminAuditEntry,
  ): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openEntry(entry);
    }
  }

  function clearFilters(): void {
    setQuery('');
    setSessionId('');
    setEventType('');
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <div className={styles.search}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search payloads…"
              aria-label="Search audit events"
            />
          </div>
          <div className={styles.filterInput}>
            <Input
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="Session ID"
              aria-label="Filter by session ID"
            />
          </div>
          <div className={styles.filterInput}>
            <Input
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              placeholder="Event type"
              aria-label="Filter by event type"
            />
          </div>
          {hasFilter ? (
            <button
              type="button"
              className={styles.clearButton}
              onClick={clearFilters}
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className={styles.meta} aria-live="polite">
          {auditQuery.isLoading
            ? 'Loading…'
            : `${entries.length} event${entries.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Session</th>
              <th scope="col" data-col="run">
                Run
              </th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Seq
              </th>
              <th scope="col" style={{ textAlign: 'right' }}>
                ID
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const time = formatTime(entry.timestamp);
              const category = categorize(entry.eventType);
              const isSelected = entry.id === selectedId;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a <tr> must remain a <tr> to stay inside <tbody>; role=button + keyboard handlers preserve the click-to-inspect affordance.
                <tr
                  key={entry.id}
                  role="button"
                  tabIndex={0}
                  data-selected={isSelected || undefined}
                  aria-label={`Inspect audit event ${entry.id} (${entry.eventType})`}
                  onClick={() => openEntry(entry)}
                  onKeyDown={(event) => handleRowKeyDown(event, entry)}
                >
                  <td className={styles.colTime}>
                    <span className={styles.timeCell}>
                      <span title={time.absolute}>{time.relative}</span>
                    </span>
                  </td>
                  <td className={styles.colEvent}>
                    <span className={styles.eventPill} data-category={category}>
                      {entry.eventType}
                    </span>
                  </td>
                  <td className={styles.colSession} title={entry.sessionId}>
                    <span className={styles.mono}>{entry.sessionId}</span>
                  </td>
                  <td className={styles.colRun} title={entry.runId}>
                    {entry.runId}
                  </td>
                  <td className={styles.colSeq}>{entry.seq}</td>
                  <td className={styles.colId}>#{entry.id}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!auditQuery.isLoading && entries.length === 0 ? (
          <div className={styles.empty}>
            No audit entries match these filters.
          </div>
        ) : null}
        {auditQuery.isLoading && entries.length === 0 ? (
          <div className={styles.empty}>Loading audit entries…</div>
        ) : null}
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className={styles.sheet}>
          <SheetHeader>
            <SheetTitle>
              {selectedEntry
                ? `Audit event #${selectedEntry.id}`
                : 'Audit event'}
            </SheetTitle>
            <SheetDescription>
              {selectedEntry?.eventType ?? ''}
            </SheetDescription>
          </SheetHeader>
          {selectedEntry ? (
            <>
              <div className={styles.sheetHeader}>
                <div className={styles.sheetHeaderMain}>
                  <span
                    className={styles.eventPill}
                    data-category={categorize(selectedEntry.eventType)}
                  >
                    {selectedEntry.eventType}
                  </span>
                  <span className={styles.sheetHeaderId}>
                    #{selectedEntry.id} ·{' '}
                    {formatDateTime(selectedEntry.timestamp)}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.sheetClose}
                  aria-label="Close inspector"
                  onClick={() => setDrawerOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className={styles.sheetBody}>
                <dl className={styles.sheetMeta}>
                  <dt>Session</dt>
                  <dd>{selectedEntry.sessionId}</dd>
                  <dt>Run ID</dt>
                  <dd>{selectedEntry.runId}</dd>
                  <dt>Parent run</dt>
                  <dd>{selectedEntry.parentRunId || '—'}</dd>
                  <dt>Seq</dt>
                  <dd>{selectedEntry.seq}</dd>
                  <dt>Timestamp</dt>
                  <dd>{formatDateTime(selectedEntry.timestamp)}</dd>
                </dl>
                <section className={styles.payloadSection}>
                  <div className={styles.payloadHeader}>
                    <span>Payload</span>
                  </div>
                  <pre className={styles.payloadBlock}>
                    {prettifyPayload(selectedEntry.payload)}
                  </pre>
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
