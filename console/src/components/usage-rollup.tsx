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

function Legend(props: { items: Segment[] }) {
  return (
    <ul className={css.legend} aria-label="Token categories">
      {props.items.map((segment) => (
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

const CHART_W = 600;
const CHART_H = 120;

/**
 * Monotone cubic (Fritsch-Carlson) interpolation: smooth like Catmull-Rom
 * but never overshoots, so a flat run followed by a jump stays on the
 * baseline instead of dipping below it.
 */
function monotonePath(points: { x: number; y: number }[]): string {
  const n = points.length;
  if (n === 0) return '';
  const fmt = (v: number) => v.toFixed(2);
  if (n === 1) return `M${fmt(points[0].x)},${fmt(points[0].y)}`;
  const dx: number[] = [];
  const dy: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1].x - points[i].x);
    dy.push(points[i + 1].y - points[i].y);
    slope.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
  }
  const tangent: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    tangent.push(
      slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2,
    );
  }
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      tangent[i] = ((3 * a) / h) * slope[i];
      tangent[i + 1] = ((3 * b) / h) * slope[i];
    }
  }
  const out = [`M${fmt(points[0].x)},${fmt(points[0].y)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const third = dx[i] / 3;
    out.push(
      `C${fmt(p1.x + third)},${fmt(p1.y + tangent[i] * third)} ${fmt(p2.x - third)},${fmt(p2.y - tangent[i + 1] * third)} ${fmt(p2.x)},${fmt(p2.y)}`,
    );
  }
  return out.join(' ');
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
    const stepX = CHART_W / (columns.length - 1);
    const yFor = (value: number) =>
      CHART_H - (max > 0 ? (value / max) * CHART_H : 0);
    const xFor = (index: number) => index * stepX;
    const totalLine = monotonePath(
      columns.map((c) => ({ x: xFor(c.index), y: yFor(c.parts.total) })),
    );
    const cachedLine = monotonePath(
      columns.map((c) => ({ x: xFor(c.index), y: yFor(c.parts.cached) })),
    );
    const close = ` L${CHART_W},${CHART_H} L0,${CHART_H} Z`;
    return {
      columns,
      max,
      peak,
      xFor,
      yFor,
      totalLine,
      totalArea: totalLine + close,
      cachedLine,
      cachedArea: cachedLine + close,
    };
  }, [trend, props.formatTrendDate]);

  if (!layout) return null;
  const { columns, max, peak, xFor, yFor } = layout;
  const active = hover == null ? null : columns[hover];
  const segments = props.showCache
    ? SEGMENTS
    : SEGMENTS.filter((s) => s.key === 'uncached' || s.key === 'output');
  const legendItems: Segment[] = [
    { key: 'uncached', label: 'Total tokens', className: css.segUncached },
    ...(props.showCache
      ? [
          {
            key: 'cached' as const,
            label: 'Served from cache',
            className: css.segCached,
          },
        ]
      : []),
  ];

  function handleMove(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.min(
      Math.max(Math.round(ratio * (columns.length - 1)), 0),
      columns.length - 1,
    );
    setHover(index);
  }

  function handleFocus(event: React.FocusEvent<SVGSVGElement>) {
    const target = event.target as Element | null;
    const raw = target?.closest('[data-index]')?.getAttribute('data-index');
    const index = raw == null ? Number.NaN : Number(raw);
    if (Number.isInteger(index) && columns[index]) setHover(index);
  }

  const tooltipLeftPct = active
    ? (active.index / (columns.length - 1)) * 100
    : 0;
  const tooltipStyle = active
    ? { left: `calc(3.4em + (100% - 3.4em) * ${tooltipLeftPct / 100})` }
    : undefined;
  const tooltipAlign =
    tooltipLeftPct > 78 ? 'end' : tooltipLeftPct < 22 ? 'start' : 'center';

  return (
    <div className={css.chart}>
      <Legend items={legendItems} />
      <div className={css.chartCanvas}>
        <div className={css.gridline} style={{ bottom: '100%' }}>
          <span>{formatCompactNumber(max)}</span>
        </div>
        <div className={css.gridline} style={{ bottom: '50%' }}>
          <span>{formatCompactNumber(max / 2)}</span>
        </div>
        <div className={css.gridline} style={{ bottom: 0 }} />
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          className={css.chartSvg}
          role="img"
          aria-label="Tokens per day, last 30 days"
          onPointerMove={handleMove}
          onPointerLeave={() => setHover(null)}
          onFocus={handleFocus}
          onBlur={() => setHover(null)}
        >
          <path d={layout.totalArea} className={css.washTotal} />
          {props.showCache ? (
            <path d={layout.cachedArea} className={css.washCached} />
          ) : null}
          <path
            d={layout.totalLine}
            className={`${css.line} ${css.lineTotal}`}
            vectorEffect="non-scaling-stroke"
          />
          {props.showCache ? (
            <path
              d={layout.cachedLine}
              className={`${css.line} ${css.lineCached}`}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {columns.map((column) => (
            <g
              key={column.date}
              tabIndex={0}
              data-index={column.index}
              className={css.pointTarget}
              aria-label={`${column.label}: ${formatCompactNumber(column.parts.total)} tokens`}
            >
              <title>{`${column.label}: ${formatCompactNumber(column.parts.total)} tokens`}</title>
              <circle
                cx={xFor(column.index)}
                cy={yFor(column.parts.total)}
                r={4}
                className={css.point}
              />
            </g>
          ))}
          {active ? (
            <line
              x1={xFor(active.index)}
              x2={xFor(active.index)}
              y1={0}
              y2={CHART_H}
              className={css.crosshair}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
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
