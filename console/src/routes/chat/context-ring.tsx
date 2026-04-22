import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChatContextSnapshot } from '../../api/chat-types';
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
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function severityFor(percent: number | null): 'nominal' | 'warn' | 'danger' {
  if (percent == null) return 'nominal';
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'nominal';
}

export interface ContextRingProps {
  snapshot: ChatContextSnapshot | null;
  isLoading?: boolean;
}

export function ContextRing({ snapshot, isLoading }: ContextRingProps) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 120);
  }, [cancelCloseTimer]);
  const openNow = useCallback(() => {
    cancelCloseTimer();
    setOpen(true);
  }, [cancelCloseTimer]);
  useEffect(() => cancelCloseTimer, [cancelCloseTimer]);

  const percent = snapshot?.contextUsagePercent ?? null;
  const clamped = clampPercent(percent);
  const severity = severityFor(percent);
  const offset =
    snapshot?.contextBudgetTokens != null && snapshot.contextUsedTokens != null
      ? RING_CIRCUMFERENCE * (1 - clamped / 100)
      : RING_CIRCUMFERENCE;

  const label =
    snapshot?.contextUsagePercent != null
      ? `${Math.round(snapshot.contextUsagePercent)}%`
      : isLoading
        ? '…'
        : '–';

  const rawPercent =
    snapshot?.contextUsagePercent != null &&
    Number.isFinite(snapshot.contextUsagePercent)
      ? Math.max(0, Math.round(snapshot.contextUsagePercent))
      : null;
  const ariaLabel =
    snapshot?.contextBudgetTokens != null &&
    snapshot.contextUsedTokens != null &&
    rawPercent != null
      ? `Context usage ${rawPercent} percent (${formatCompact(snapshot.contextUsedTokens)} of ${formatCompact(snapshot.contextBudgetTokens)} tokens)`
      : 'Context usage unavailable';

  return (
    <div className={css.wrap}>
      <button
        type="button"
        className={css.trigger}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onBlur={scheduleClose}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-describedby={open ? popoverId : undefined}
      >
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
            snapshot?.contextUsagePercent == null && css.ringLabelUnknown,
          )}
        >
          {label}
        </span>
      </button>
      {open ? (
        <div
          id={popoverId}
          role="tooltip"
          className={css.popover}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        >
          <div className={css.popoverTitle}>
            <span>Context</span>
            <span className={css.popoverTitleValue}>
              {snapshot?.model || 'unknown model'}
            </span>
          </div>
          {snapshot?.contextBudgetTokens != null &&
          snapshot.contextUsedTokens != null ? (
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
                  : isLoading
                    ? 'loading…'
                    : 'no usage recorded yet'}
              </span>
            </div>
          )}
          {snapshot ? (
            <div className={css.popoverRow}>
              <span>Compactions</span>
              <span className={css.popoverRowValue}>
                {snapshot.compactionCount} ·{' '}
                {formatCompact(snapshot.compactionMessageThreshold)} msgs /{' '}
                {formatCompact(snapshot.compactionTokenBudget)} tokens
              </span>
            </div>
          ) : null}
          <div className={css.popoverFoot}>
            Run <code>/context</code> for full details · <code>/compact</code>{' '}
            to archive older history.
          </div>
        </div>
      ) : null}
    </div>
  );
}
