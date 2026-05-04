import { useQuery } from '@tanstack/react-query';
import { fetchChatContext } from '../../api/chat';
import { isAuthReadyForApi, useAuth } from '../../auth';
import { cx } from '../../lib/cx';
import css from './context-ring.module.css';

const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatCompact(value: number | null | undefined): string {
  if (value == null) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const scaled =
      abs >= 10_000_000
        ? (value / 1_000_000).toFixed(0)
        : (value / 1_000_000).toFixed(1);
    return `${scaled.replace(/\.0$/, '')}M`;
  }
  if (abs >= 1_000) {
    const scaled =
      abs >= 10_000 ? (value / 1_000).toFixed(0) : (value / 1_000).toFixed(1);
    return `${scaled.replace(/\.0$/, '')}k`;
  }
  return String(Math.round(value));
}

function clampPercent(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function severityFor(percent: number | null): 'nominal' | 'warn' | 'danger' {
  if (percent == null) return 'nominal';
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'nominal';
}

interface ContextRingProps {
  sessionId: string;
}

// ContextRing is only rendered on the chat route (via ChatPage). Callers
// must not mount it elsewhere — there's no route-based opt-out here.
export function ContextRing(props: ContextRingProps) {
  const auth = useAuth();
  const sessionId = props.sessionId;
  const enabled = isAuthReadyForApi(auth) && Boolean(sessionId);
  const query = useQuery({
    queryKey: ['chat-context', auth.token, sessionId],
    queryFn: () => fetchChatContext(auth.token, sessionId),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const snapshot = query.data?.snapshot ?? null;
  const percent = snapshot?.contextUsagePercent ?? null;
  const clamped = clampPercent(percent);
  const severity = severityFor(percent);
  const hasBudget =
    snapshot?.contextBudgetTokens != null && snapshot.contextUsedTokens != null;
  const offset = hasBudget
    ? RING_CIRCUMFERENCE * (1 - clamped / 100)
    : RING_CIRCUMFERENCE;

  const rawPercent =
    percent != null && Number.isFinite(percent)
      ? Math.max(0, Math.round(percent))
      : null;
  const label = rawPercent != null ? `${rawPercent}%` : '–';
  const ariaLabel =
    snapshot && hasBudget && rawPercent != null
      ? `Context usage ${rawPercent} percent (${formatCompact(snapshot.contextUsedTokens)} of ${formatCompact(snapshot.contextBudgetTokens)} tokens)`
      : 'Context usage unavailable';

  return (
    <div className={css.wrap}>
      <button type="button" className={css.trigger} aria-label={ariaLabel}>
        <svg
          width={34}
          height={34}
          viewBox="0 0 34 34"
          className={css.ring}
          aria-hidden="true"
        >
          <circle cx={17} cy={17} r={RING_RADIUS} className={css.ringTrack} />
          <circle
            cx={17}
            cy={17}
            r={RING_RADIUS}
            className={cx(
              css.ringFill,
              severity === 'warn' && css.ringFillWarn,
              severity === 'danger' && css.ringFillDanger,
              severity === 'nominal' && css.ringFillNominal,
            )}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={offset}
          />
        </svg>
        <span
          className={cx(
            css.ringLabel,
            rawPercent == null && css.ringLabelUnknown,
          )}
        >
          {label}
        </span>
      </button>
      <div role="tooltip" className={css.popover}>
        <div className={css.popoverTitle}>
          <span>Context</span>
          <span className={css.popoverTitleValue}>
            {snapshot?.model || 'unknown model'}
          </span>
        </div>
        {snapshot && hasBudget ? (
          <>
            <div className={css.popoverProgress}>
              <div
                className={cx(
                  css.popoverProgressFill,
                  severity === 'warn' && css.popoverProgressFillWarn,
                  severity === 'danger' && css.popoverProgressFillDanger,
                )}
                style={{ width: `${clamped}%` }}
              />
            </div>
            <div className={css.popoverRow}>
              <span>Used</span>
              <span className={css.popoverRowValue}>
                {formatCompact(snapshot.contextUsedTokens)} /{' '}
                {formatCompact(snapshot.contextBudgetTokens)} tokens
              </span>
            </div>
            <div className={css.popoverRow}>
              <span>Headroom</span>
              <span className={css.popoverRowValue}>
                {formatCompact(snapshot.contextRemainingTokens)} tokens
              </span>
            </div>
          </>
        ) : (
          <div className={css.popoverRow}>
            <span>Used</span>
            <span className={css.popoverRowValue}>
              {snapshot?.contextUsedTokens != null
                ? `${formatCompact(snapshot.contextUsedTokens)} tokens`
                : 'no usage recorded yet'}
            </span>
          </div>
        )}
        <div className={css.popoverRow}>
          <span>Compactions</span>
          <span className={css.popoverRowValue}>
            {snapshot
              ? `${snapshot.compactionCount} · ${formatCompact(snapshot.compactionMessageThreshold)} msgs / ${formatCompact(snapshot.compactionTokenBudget)} tokens`
              : 'n/a'}
          </span>
        </div>
        <div className={css.popoverFoot}>
          Run <code>/context</code> for full details · <code>/compact</code> to
          archive older history.
        </div>
      </div>
    </div>
  );
}
