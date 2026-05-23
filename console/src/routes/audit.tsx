import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchAudit } from '../api/client';
import type { AdminAuditEntry } from '../api/types';
import { useAuth } from '../auth';
import { Search as SearchIcon } from '../components/icons';
import { Input } from '../components/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '../components/sheet';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { logNavigationError } from '../lib/navigation';
import styles from './audit.module.css';
import {
  parseAuditSearch,
  removeAuditField,
  setAuditField,
} from './audit-search';

const CATEGORIES = [
  'session',
  'turn',
  'model',
  'tool',
  'autonomy',
  'authorization',
  'approval',
  'a2a',
] as const;
type Category = (typeof CATEGORIES)[number];

const KNOWN_CATEGORIES = new Set<string>(CATEGORIES);

const TIME_RANGES = [
  { value: 'all', label: 'All' },
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
] as const;
type TimeRange = (typeof TIME_RANGES)[number]['value'];
const TIME_RANGE_VALUES = new Set<string>(TIME_RANGES.map((r) => r.value));

const RANGE_TO_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

function categorize(eventType: string): Category | 'default' {
  const prefix = eventType.split('.', 1)[0] ?? '';
  return KNOWN_CATEGORIES.has(prefix) ? (prefix as Category) : 'default';
}

function prettifyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

function withinRange(timestamp: string, range: TimeRange): boolean {
  if (range === 'all') return true;
  const cutoff = Date.now() - RANGE_TO_MS[range];
  const ts = Date.parse(timestamp);
  return Number.isFinite(ts) && ts >= cutoff;
}

type AuditSearchParams = { q: string | undefined; range: string | undefined };

function readRange(value: string | undefined): TimeRange {
  return value && TIME_RANGE_VALUES.has(value) ? (value as TimeRange) : 'all';
}

export function AuditPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as AuditSearchParams;
  const initialQ = search.q ?? '';
  const initialRange = readRange(search.range);

  const [searchInput, setSearchInput] = useState(initialQ);
  const [range, setRange] = useState<TimeRange>(initialRange);
  const [selectedEntry, setSelectedEntry] = useState<AdminAuditEntry | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastSyncedQ = useRef<string | undefined>(search.q);
  const lastSyncedRange = useRef<string | undefined>(search.range);

  const deferredSearchInput = useDeferredValue(searchInput);
  const parsed = useMemo(
    () => parseAuditSearch(deferredSearchInput),
    [deferredSearchInput],
  );

  // state → URL: skip when the URL already matches to avoid pointless
  // history replacements on every keystroke.
  useEffect(() => {
    const nextQ = searchInput.trim() || undefined;
    const nextRange = range === 'all' ? undefined : range;
    if (nextQ === search.q && nextRange === search.range) return;
    lastSyncedQ.current = nextQ;
    lastSyncedRange.current = nextRange;
    void navigate({
      to: '/admin/audit',
      search: { q: nextQ, range: nextRange },
      replace: true,
    }).catch(logNavigationError);
  }, [navigate, searchInput, range, search.q, search.range]);

  // URL → state: re-seed when the URL changes for any reason other than
  // our own write (back/forward navigation, deep link).
  useEffect(() => {
    if (search.q !== lastSyncedQ.current) {
      lastSyncedQ.current = search.q;
      setSearchInput(search.q ?? '');
    }
    if (search.range !== lastSyncedRange.current) {
      lastSyncedRange.current = search.range;
      setRange(readRange(search.range));
    }
  }, [search.q, search.range]);

  // Global `/` shortcut to focus the search input.
  useEffect(() => {
    function handler(event: globalThis.KeyboardEvent): void {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const auditQuery = useQuery({
    queryKey: [
      'audit',
      auth.token,
      parsed.query,
      parsed.sessionId,
      parsed.eventType,
    ],
    queryFn: () =>
      fetchAudit(auth.token, {
        query: parsed.query,
        sessionId: parsed.sessionId,
        eventType: parsed.eventType,
        limit: 200,
      }),
  });

  const entries = useMemo(() => {
    const data = auditQuery.data?.entries ?? [];
    return data.filter((entry) => withinRange(entry.timestamp, range));
  }, [auditQuery.data, range]);

  const activeCategory: Category | null = useMemo(() => {
    const v = parsed.eventType;
    if (v && KNOWN_CATEGORIES.has(v)) return v as Category;
    return null;
  }, [parsed.eventType]);

  const hasAnyFilter = Boolean(
    parsed.query || parsed.sessionId || parsed.eventType || range !== 'all',
  );

  function openEntry(entry: AdminAuditEntry): void {
    setSelectedEntry(entry);
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

  const toggleCategory = useCallback((category: Category | null) => {
    setSearchInput((current) => {
      if (category === null) return removeAuditField(current, 'type');
      const next = parseAuditSearch(current).eventType;
      if (next === category) return removeAuditField(current, 'type');
      return setAuditField(current, 'type', category);
    });
  }, []);

  function removeSessionFilter(): void {
    setSearchInput((current) => removeAuditField(current, 'session'));
  }

  function removeTypeFilter(): void {
    setSearchInput((current) => removeAuditField(current, 'type'));
  }

  function clearAll(): void {
    setSearchInput('');
    setRange('all');
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.searchRow}>
          <div className={styles.searchWrap}>
            <SearchIcon className={styles.searchIcon} aria-hidden="true" />
            <Input
              ref={searchRef}
              className={styles.searchInput}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search payloads… try session:web type:tool"
              aria-label="Audit search"
              spellCheck={false}
              autoComplete="off"
            />
            <span
              className={styles.shortcutHint}
              data-hidden={searchInput ? 'true' : undefined}
              aria-hidden="true"
            >
              /
            </span>
          </div>

          <div
            className={styles.timeRange}
            role="toolbar"
            aria-label="Time range"
          >
            {TIME_RANGES.map((option) => {
              const active = range === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  data-active={active || undefined}
                  onClick={() => setRange(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className={styles.meta} aria-live="polite">
            {auditQuery.isLoading
              ? 'Loading…'
              : `${entries.length} event${entries.length === 1 ? '' : 's'}`}
          </div>
        </div>

        <div
          className={styles.chipRow}
          role="toolbar"
          aria-label="Event category"
        >
          <button
            type="button"
            className={styles.categoryChip}
            data-category="all"
            aria-pressed={activeCategory === null}
            data-active={activeCategory === null || undefined}
            onClick={() => toggleCategory(null)}
          >
            all
          </button>
          {CATEGORIES.map((category) => {
            const active = activeCategory === category;
            return (
              <button
                key={category}
                type="button"
                className={styles.categoryChip}
                data-category={category}
                aria-pressed={active}
                data-active={active || undefined}
                onClick={() => toggleCategory(category)}
              >
                {category}
              </button>
            );
          })}
        </div>

        <div
          className={styles.activeRow}
          data-empty={hasAnyFilter ? undefined : 'true'}
          aria-live="polite"
        >
          {parsed.sessionId ? (
            <span className={styles.activeChip}>
              <strong>session:</strong>
              {parsed.sessionId}
              <button
                type="button"
                className={styles.activeChipRemove}
                aria-label={`Remove session filter ${parsed.sessionId}`}
                onClick={removeSessionFilter}
              >
                ×
              </button>
            </span>
          ) : null}
          {parsed.eventType ? (
            <span className={styles.activeChip}>
              <strong>type:</strong>
              {parsed.eventType}
              <button
                type="button"
                className={styles.activeChipRemove}
                aria-label={`Remove event type filter ${parsed.eventType}`}
                onClick={removeTypeFilter}
              >
                ×
              </button>
            </span>
          ) : null}
          {range !== 'all' ? (
            <span className={styles.activeChip}>
              <strong>last:</strong>
              {range}
              <button
                type="button"
                className={styles.activeChipRemove}
                aria-label="Reset time range"
                onClick={() => setRange('all')}
              >
                ×
              </button>
            </span>
          ) : null}
          {hasAnyFilter ? (
            <button
              type="button"
              className={styles.clearAll}
              onClick={clearAll}
            >
              Clear all
            </button>
          ) : null}
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
              <th scope="col" className={styles.colSeq}>
                Seq
              </th>
              <th scope="col" className={styles.colId}>
                ID
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const category = categorize(entry.eventType);
              const isSelected = entry.id === selectedEntry?.id;
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
                  <td
                    className={styles.colTime}
                    title={formatDateTime(entry.timestamp)}
                  >
                    {formatRelativeTime(entry.timestamp)}
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
        {entries.length === 0 ? (
          <div className={styles.empty}>
            {auditQuery.isLoading
              ? 'Loading audit entries…'
              : 'No audit entries match these filters.'}
          </div>
        ) : null}
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className={styles.sheet}>
          <SheetHeader>
            <SheetTitle>
              {selectedEntry
                ? `Audit event #${selectedEntry.id} (${selectedEntry.eventType})`
                : 'Audit event'}
            </SheetTitle>
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
