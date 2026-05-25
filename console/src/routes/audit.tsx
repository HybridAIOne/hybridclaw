import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  type KeyboardEvent as ReactKeyboardEvent,
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
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatRelativeTime, pluralize } from '../lib/format';
import { logNavigationError } from '../lib/navigation';
import { isOneOf } from '../lib/oneof';
import styles from './audit.module.css';
import {
  CATEGORIES,
  type Category,
  categorize,
  rangeToSince,
  readRange,
  TIME_RANGES,
  type TimeRange,
} from './audit-filters';
import {
  parseAuditSearch,
  removeAuditField,
  setAuditField,
} from './audit-search';

const PAGE_SIZE = 200;

function prettifyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

type AuditSearchParams = { q: string | undefined; range: string | undefined };

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
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const lastSyncedQ = useRef<string | undefined>(search.q);
  const lastSyncedRange = useRef<string | undefined>(search.range);

  // Parse eagerly for UI (chips, active-filter row). The queryKey gets
  // the deferred values below so typing doesn't refetch on every keystroke.
  const parsed = useMemo(() => parseAuditSearch(searchInput), [searchInput]);
  const deferredQuery = useDeferredValue(parsed.query);
  const deferredSessionId = useDeferredValue(parsed.sessionId);
  const deferredEventType = useDeferredValue(parsed.eventType);

  // state → URL. Gates off `lastSynced*` refs instead of `search.*` so an
  // external URL change (back/forward) handled by the URL→state effect
  // below doesn't trip this one into navigating back to the stale value.
  useEffect(() => {
    const nextQ = searchInput.trim() || undefined;
    const nextRange = range === 'all' ? undefined : range;
    if (
      nextQ === lastSyncedQ.current &&
      nextRange === lastSyncedRange.current
    ) {
      return;
    }
    lastSyncedQ.current = nextQ;
    lastSyncedRange.current = nextRange;
    void navigate({
      to: '/admin/audit',
      search: { q: nextQ, range: nextRange },
      replace: true,
    }).catch(logNavigationError);
  }, [navigate, searchInput, range]);

  // URL → state: re-seed when the URL changes for any reason other than
  // our own write (back/forward navigation, deep link). Updates the refs
  // so the state→URL effect treats the new value as already-synced.
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
    function handler(event: KeyboardEvent): void {
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

  // Cutoff is computed at render time and baked into the queryKey below.
  // For an idle admin page this is fine; any user interaction (filter
  // change, scroll-triggered fetchNextPage) re-renders and refreshes it.
  const since = useMemo(() => rangeToSince(range), [range]);

  const auditQuery = useInfiniteQuery({
    queryKey: [
      'audit',
      auth.token,
      deferredQuery,
      deferredSessionId,
      deferredEventType,
      since,
    ],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      fetchAudit(auth.token, {
        query: deferredQuery,
        sessionId: deferredSessionId,
        eventType: deferredEventType,
        since,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // Auto-fetch the next page when the sentinel near the bottom enters view.
  // The Load more button remains as the keyboard/screen-reader fallback and
  // as the visible loading indicator while a fetch is in flight.
  //
  // Only `hasNextPage` is in the deps: re-attaching the observer on every
  // `isFetchingNextPage` flip would tear it down before the async initial
  // callback ever landed, silently breaking auto-fetch. The callback reads
  // the latest state via a ref instead.
  const auditQueryRef = useRef(auditQuery);
  auditQueryRef.current = auditQuery;
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !auditQuery.hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const q = auditQueryRef.current;
        if (entry?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) {
          void q.fetchNextPage();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [auditQuery.hasNextPage]);

  const entries = useMemo<AdminAuditEntry[]>(
    () => auditQuery.data?.pages.flatMap((page) => page.entries) ?? [],
    [auditQuery.data],
  );

  const activeCategory: Category | null = useMemo(() => {
    const v = parsed.eventType;
    return v && isOneOf(CATEGORIES, v) ? v : null;
  }, [parsed.eventType]);

  const hasAnyFilter = Boolean(
    parsed.query || parsed.sessionId || parsed.eventType || range !== 'all',
  );

  function openEntry(entry: AdminAuditEntry): void {
    setSelectedEntry(entry);
    setDrawerOpen(true);
  }

  function handleRowKeyDown(
    event: ReactKeyboardEvent<HTMLTableRowElement>,
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
              : auditQuery.isError
                ? 'Failed to load'
                : pluralize(entries.length, 'event')}
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
            {auditQuery.isLoading ? (
              'Loading audit entries…'
            ) : auditQuery.isError ? (
              <span className={styles.emptyError} role="alert">
                Couldn't load audit events — {getErrorMessage(auditQuery.error)}
                .{' '}
                <button
                  type="button"
                  className={styles.retry}
                  onClick={() => {
                    void auditQuery.refetch();
                  }}
                >
                  Retry
                </button>
              </span>
            ) : (
              'No audit entries match these filters.'
            )}
          </div>
        ) : null}
        {auditQuery.hasNextPage ? (
          <div ref={loadMoreRef} className={styles.loadMoreRow}>
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => {
                void auditQuery.fetchNextPage();
              }}
              disabled={auditQuery.isFetchingNextPage}
            >
              {auditQuery.isFetchingNextPage
                ? 'Loading…'
                : auditQuery.isFetchNextPageError
                  ? 'Retry'
                  : 'Load more'}
            </button>
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
          {/*
            `selectedEntry` is deliberately retained while the sheet animates
            closed, and across filter changes that refetch a different result
            set — see the "drawer body survives a filter change" regression
            test. Clearing it on close would blank the body mid-exit-animation.
          */}
          {selectedEntry ? (
            <AuditInspector
              entry={selectedEntry}
              onClose={() => setDrawerOpen(false)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AuditInspector({
  entry,
  onClose,
}: {
  entry: AdminAuditEntry;
  onClose: () => void;
}) {
  return (
    <>
      <div className={styles.sheetHeader}>
        <div className={styles.sheetHeaderMain}>
          <span
            className={styles.eventPill}
            data-category={categorize(entry.eventType)}
          >
            {entry.eventType}
          </span>
          <span className={styles.sheetHeaderId}>
            #{entry.id} · {formatDateTime(entry.timestamp)}
          </span>
        </div>
        <button
          type="button"
          className={styles.sheetClose}
          aria-label="Close inspector"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className={styles.sheetBody}>
        <dl className={styles.sheetMeta}>
          <dt>Session</dt>
          <dd>{entry.sessionId}</dd>
          <dt>Run ID</dt>
          <dd>{entry.runId}</dd>
          <dt>Parent run</dt>
          <dd>{entry.parentRunId || '—'}</dd>
          <dt>Seq</dt>
          <dd>{entry.seq}</dd>
          <dt>Timestamp</dt>
          <dd>{formatDateTime(entry.timestamp)}</dd>
        </dl>
        <section className={styles.payloadSection}>
          <div className={styles.payloadHeader}>
            <span>Payload</span>
          </div>
          <pre className={styles.payloadBlock}>
            {prettifyPayload(entry.payload)}
          </pre>
        </section>
      </div>
    </>
  );
}
