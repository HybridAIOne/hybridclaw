import { useMemo, useState } from 'react';
import type {
  AdminModelUsageRow,
  AdminOverview,
  AdminStatisticsTrendDay,
} from '../api/types';
import {
  cacheHitRatio,
  formatCacheHit,
  formatCompactNumber,
  pluralize,
} from '../lib/format';
import css from './usage-rollup.module.css';

// Keep the rollup compact: zero is bare, nonzero values are capped at cents.
function formatUsdCompact(value: number): string {
  if (value === 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

type SegmentKey = 'uncached' | 'cached' | 'cacheWrite' | 'output';

interface Segment {
  key: SegmentKey;
  label: string;
  className: string;
}

const SEGMENTS: Segment[] = [
  { key: 'uncached', label: 'Input', className: css.segUncached },
  { key: 'cacheWrite', label: 'Cache write', className: css.segCacheWrite },
  { key: 'cached', label: 'Cached input', className: css.segCached },
  { key: 'output', label: 'Output', className: css.segOutput },
];

interface TokenParts {
  uncached: number;
  cached: number;
  cacheWrite: number;
  output: number;
  total: number;
  hitRatio: number | null;
}

function splitTokens(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): TokenParts {
  const input = Math.max(0, row.inputTokens);
  const cached = Math.min(input, Math.max(0, row.cacheReadTokens));
  const cacheWrite = Math.min(
    input - cached,
    Math.max(0, row.cacheWriteTokens),
  );
  const output = Math.max(0, row.outputTokens);
  return {
    uncached: input - cached - cacheWrite,
    cached,
    cacheWrite,
    output,
    total: input + output,
    hitRatio: cacheHitRatio(input, cached),
  };
}

function splitSummary(row: {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
}): TokenParts {
  return splitTokens({
    inputTokens: row.totalInputTokens,
    outputTokens: row.totalOutputTokens,
    cacheReadTokens: row.totalCacheReadTokens ?? 0,
    cacheWriteTokens: row.totalCacheWriteTokens ?? 0,
  });
}

export interface UsageRollupProps {
  usage: AdminOverview['usage'];
  trend: AdminStatisticsTrendDay[] | null;
  formatTrendDate: (isoDate: string) => string;
}

export function UsageRollup(props: UsageRollupProps) {
  const { daily, monthly, topModels } = props.usage;
  const hasMonthly = monthly.callCount > 0 || monthly.totalTokens > 0;
  const hasDaily = daily.callCount > 0 || daily.totalTokens > 0;

  if (!hasMonthly && !hasDaily) {
    return (
      <p className={css.empty}>No usage has been recorded yet this month.</p>
    );
  }

  const month = splitSummary(monthly);
  const showCache = month.cached > 0 || month.cacheWrite > 0;

  return (
    <div className={css.root}>
      <p className={css.summary}>
        <strong>{formatCompactNumber(monthly.totalTokens)}</strong> tokens this
        month · {formatCompactNumber(daily.totalTokens)} today
      </p>

      <div className={css.ribbon}>
        <Metric
          label="Spent"
          value={formatUsdCompact(monthly.totalCostUsd)}
          detail={pluralize(monthly.callCount, 'call')}
        />
        <Metric
          label="Cache hit"
          value={formatCacheHit(month.hitRatio)}
          detail={
            month.hitRatio == null
              ? 'no cache reported'
              : `${formatCompactNumber(month.cached)} of ${formatCompactNumber(month.cached + month.cacheWrite + month.uncached)} input`
          }
        />
        <Metric
          label="Input"
          value={formatCompactNumber(monthly.totalInputTokens)}
          detail={
            month.cacheWrite > 0
              ? `${formatCompactNumber(month.cacheWrite)} written to cache`
              : undefined
          }
        />
        <Metric
          label="Output"
          value={formatCompactNumber(monthly.totalOutputTokens)}
        />
      </div>

      <UsageChart
        trend={props.trend}
        formatTrendDate={props.formatTrendDate}
        showCache={showCache}
      />

      {topModels.length > 1 ? (
        <ModelBreakdown models={topModels} showCache={showCache} />
      ) : null}
    </div>
  );
}

function Metric(props: { label: string; value: string; detail?: string }) {
  return (
    <div className={css.metric}>
      <span className={css.metricLabel}>{props.label}</span>
      <span className={css.metricValue}>{props.value}</span>
      {props.detail ? (
        <span className={css.metricDetail}>{props.detail}</span>
      ) : null}
    </div>
  );
}

function Legend(props: { showCache: boolean }) {
  const segments = props.showCache
    ? SEGMENTS
    : SEGMENTS.filter((s) => s.key === 'uncached' || s.key === 'output');
  return (
    <ul className={css.legend} aria-label="Token categories">
      {segments.map((segment) => (
        <li key={segment.key} className={css.legendItem}>
          <span
            aria-hidden="true"
            className={`${css.swatch} ${segment.className}`}
          />
          {segment.label}
        </li>
      ))}
    </ul>
  );
}

interface DayColumn {
  index: number;
  date: string;
  label: string;
  parts: TokenParts;
}

function UsageChart(props: {
  trend: AdminStatisticsTrendDay[] | null;
  formatTrendDate: (isoDate: string) => string;
  showCache: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const trend = props.trend;

  const layout = useMemo(() => {
    if (!trend || trend.length < 2) return null;
    const columns: DayColumn[] = trend.map((day, index) => ({
      index,
      date: day.date,
      label: props.formatTrendDate(day.date),
      parts: splitTokens({
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheReadTokens: day.cacheReadTokens ?? 0,
        cacheWriteTokens: day.cacheWriteTokens ?? 0,
      }),
    }));
    const max = Math.max(0, ...columns.map((c) => c.parts.total));
    const peak = columns.reduce<DayColumn | null>(
      (best, c) => (c.parts.total > (best?.parts.total ?? 0) ? c : best),
      null,
    );
    return { columns, max, peak };
  }, [trend, props.formatTrendDate]);

  if (!layout) return null;
  const { columns, max, peak } = layout;
  const active = hover == null ? null : columns[hover];
  const segments = props.showCache
    ? SEGMENTS
    : SEGMENTS.filter((s) => s.key === 'uncached' || s.key === 'output');
  const tooltipLeftPct = active
    ? ((active.index + 0.5) / columns.length) * 100
    : 0;
  const tooltipStyle = active
    ? { left: `calc(3.4em + (100% - 3.4em) * ${tooltipLeftPct / 100})` }
    : undefined;
  const tooltipAlign =
    tooltipLeftPct > 78 ? 'end' : tooltipLeftPct < 22 ? 'start' : 'center';

  return (
    <div className={css.chart}>
      <Legend showCache={props.showCache} />
      <div className={css.chartCanvas}>
        <div className={css.gridline} style={{ bottom: '100%' }}>
          <span>{formatCompactNumber(max)}</span>
        </div>
        <div className={css.gridline} style={{ bottom: '50%' }}>
          <span>{formatCompactNumber(max / 2)}</span>
        </div>
        <div
          className={css.columns}
          role="img"
          aria-label="Tokens per day, last 30 days"
          onPointerLeave={() => setHover(null)}
        >
          {columns.map((column) => {
            const label = `${column.label}: ${formatCompactNumber(column.parts.total)} tokens`;
            return (
              <button
                type="button"
                key={column.date}
                className={css.column}
                data-active={hover === column.index || undefined}
                onPointerEnter={() => setHover(column.index)}
                onFocus={() => setHover(column.index)}
                onBlur={() => setHover(null)}
                aria-label={label}
                title={label}
              >
                <div className={css.stack}>
                  {segments.map((segment) => {
                    const value = column.parts[segment.key];
                    if (value <= 0 || max <= 0) return null;
                    return (
                      <div
                        key={segment.key}
                        className={`${css.segment} ${segment.className}`}
                        style={{ height: `${(value / max) * 100}%` }}
                      />
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
        {active ? (
          <div
            className={css.tooltip}
            data-align={tooltipAlign}
            style={tooltipStyle}
            role="status"
            aria-live="polite"
          >
            <span className={css.tooltipTitle}>
              {active.label}
              <span className={css.tooltipTotal}>
                {formatCompactNumber(active.parts.total)} tokens
              </span>
            </span>
            {segments.map((segment) => (
              <span key={segment.key} className={css.tooltipRow}>
                <span
                  aria-hidden="true"
                  className={`${css.lineKey} ${segment.className}`}
                />
                <span className={css.tooltipValue}>
                  {formatCompactNumber(active.parts[segment.key])}
                </span>
                <span className={css.tooltipLabel}>{segment.label}</span>
              </span>
            ))}
            {active.parts.hitRatio != null ? (
              <span className={css.tooltipHit}>
                {formatCacheHit(active.parts.hitRatio)} cache hit
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={css.axis} aria-hidden="true">
        <span>{columns.length - 1}d ago</span>
        {peak && peak.parts.total > 0 ? (
          <span className={css.axisPeak}>
            peak {formatCompactNumber(peak.parts.total)} on {peak.label}
          </span>
        ) : null}
        <span>today</span>
      </div>
    </div>
  );
}

function ModelBreakdown(props: {
  models: AdminModelUsageRow[];
  showCache: boolean;
}) {
  const rows = props.models.map((row) => ({
    row,
    parts: splitSummary(row),
  }));
  const max = Math.max(0, ...rows.map((r) => r.parts.total));
  const segments = props.showCache
    ? SEGMENTS
    : SEGMENTS.filter((s) => s.key === 'uncached' || s.key === 'output');

  return (
    <ul className={css.models} aria-label="Usage by model">
      {rows.map(({ row, parts }) => {
        const detail = [
          `${formatCompactNumber(row.totalInputTokens)} in`,
          `${formatCompactNumber(row.totalOutputTokens)} out`,
          ...(parts.cached > 0
            ? [`${formatCompactNumber(parts.cached)} cached`]
            : []),
          ...(parts.cacheWrite > 0
            ? [`${formatCompactNumber(parts.cacheWrite)} cache write`]
            : []),
          pluralize(row.callCount, 'call'),
        ].join(' · ');
        return (
          <li key={row.model} className={css.modelRow} title={detail}>
            <span className={css.modelName}>{row.model}</span>
            <span className={css.modelBar} role="img" aria-label={detail}>
              <span
                className={css.modelBarFill}
                style={{ width: `${max > 0 ? (parts.total / max) * 100 : 0}%` }}
              >
                {segments.map((segment) => {
                  const value = parts[segment.key];
                  if (value <= 0 || parts.total <= 0) return null;
                  return (
                    <span
                      key={segment.key}
                      className={`${css.modelSegment} ${segment.className}`}
                      style={{ flexBasis: `${(value / parts.total) * 100}%` }}
                    />
                  );
                })}
              </span>
            </span>
            <span className={css.modelTokens}>
              {formatCompactNumber(parts.total)}
            </span>
            {props.showCache ? (
              <span className={css.modelHit}>
                {parts.hitRatio == null
                  ? '—'
                  : `${formatCacheHit(parts.hitRatio)} cached`}
              </span>
            ) : null}
            <span className={css.modelCost}>
              {formatUsdCompact(row.totalCostUsd)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
