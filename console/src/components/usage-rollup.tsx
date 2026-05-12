import { useMemo, useState } from 'react';
import type { AdminOverview, AdminStatisticsTrendDay } from '../api/types';
import {
  formatCompactNumber,
  formatTokenBreakdown,
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

const CHART_VIEWBOX_WIDTH = 600;
const CHART_VIEWBOX_HEIGHT = 100;

interface ChartPoint {
  index: number;
  label: string;
  value: number;
  x: number;
  y: number;
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

  const summary = monthly;
  const showTopModels = topModels.length > 1;

  return (
    <div className={css.root}>
      <p className={css.summary}>
        <strong>{formatCompactNumber(summary.totalTokens)}</strong> tokens this
        month · {formatCompactNumber(daily.totalTokens)} today
      </p>

      <div className={css.ribbon}>
        <Metric
          label="Input"
          value={formatCompactNumber(summary.totalInputTokens ?? 0)}
        />
        <Metric
          label="Output"
          value={formatCompactNumber(summary.totalOutputTokens ?? 0)}
        />
        <Metric label="Calls" value={formatCompactNumber(summary.callCount)} />
        <Metric label="Spent" value={formatUsdCompact(summary.totalCostUsd)} />
      </div>

      <UsageChart trend={props.trend} formatTrendDate={props.formatTrendDate} />

      {showTopModels ? (
        <ul className={css.topModels}>
          {topModels.map((row) => (
            <li key={row.model} className={css.topModelRow}>
              <span className={css.topModelName}>{row.model}</span>
              <span className={css.topModelDetail}>
                {formatTokenBreakdown({
                  inputTokens: row.totalInputTokens ?? 0,
                  outputTokens: row.totalOutputTokens ?? 0,
                })}{' '}
                · {pluralize(row.callCount, 'call')}
              </span>
              <span className={css.topModelCost}>
                {formatUsdCompact(row.totalCostUsd)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className={css.metric}>
      <span className={css.metricLabel}>{props.label}</span>
      <span className={css.metricValue}>{props.value}</span>
    </div>
  );
}

interface HoverState {
  index: number;
  point: ChartPoint;
}

function UsageChart(props: {
  trend: AdminStatisticsTrendDay[] | null;
  formatTrendDate: (isoDate: string) => string;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const trend = props.trend;

  const layout = useMemo(() => {
    if (!trend || trend.length < 2) return null;
    const max = Math.max(0, ...trend.map((d) => d.totalTokens));
    const stepX = CHART_VIEWBOX_WIDTH / (trend.length - 1);
    const points: ChartPoint[] = trend.map((day, index) => {
      const ratio = max > 0 ? Math.sqrt(day.totalTokens / max) : 0;
      return {
        index,
        label: props.formatTrendDate(day.date),
        value: day.totalTokens,
        x: index * stepX,
        y: CHART_VIEWBOX_HEIGHT - ratio * CHART_VIEWBOX_HEIGHT,
      };
    });
    const linePath = buildSmoothPath(points);
    const areaPath = `${linePath} L${CHART_VIEWBOX_WIDTH},${CHART_VIEWBOX_HEIGHT} L0,${CHART_VIEWBOX_HEIGHT} Z`;
    const peak = points.reduce<ChartPoint | null>(
      (best, p) => (p.value > (best?.value ?? -1) ? p : best),
      null,
    );
    return { points, linePath, areaPath, peak };
  }, [trend, props.formatTrendDate]);

  if (!layout) return null;

  const { points, linePath, areaPath, peak } = layout;
  const peakLabel =
    peak && peak.value > 0
      ? `peak ${formatCompactNumber(peak.value)} on ${peak.label}`
      : null;

  function handleMove(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const clamped = Math.min(Math.max(ratio, 0), 0.9999);
    const index = Math.min(
      Math.max(Math.floor(clamped * points.length), 0),
      points.length - 1,
    );
    const point = points[index];
    if (!point) return;
    setHover({ index, point });
  }

  function handleLeave() {
    setHover(null);
  }

  const tooltipLeftPct = hover
    ? (hover.point.x / CHART_VIEWBOX_WIDTH) * 100
    : 0;
  const tooltipAlign = !hover
    ? 'center'
    : tooltipLeftPct > 80
      ? 'end'
      : tooltipLeftPct < 18
        ? 'start'
        : 'center';

  return (
    <div className={css.chart}>
      <div className={css.chartCanvas}>
        <svg
          viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
          preserveAspectRatio="none"
          className={css.chartSvg}
          role="img"
          aria-label="Tokens per day, last 30 days"
          onPointerMove={handleMove}
          onPointerLeave={handleLeave}
        >
          <path d={areaPath} className={css.area} />
          <path
            d={linePath}
            className={css.line}
            vectorEffect="non-scaling-stroke"
          />
          {points.map((point) => {
            const pointLabel = `${point.label}: ${formatCompactNumber(point.value)} tokens`;
            return (
              <g
                key={point.index}
                className={css.pointTarget}
                tabIndex={0}
                aria-label={pointLabel}
              >
                <title>{pointLabel}</title>
                <circle cx={point.x} cy={point.y} r={5} className={css.point} />
              </g>
            );
          })}
          {hover ? (
            <line
              x1={hover.point.x}
              x2={hover.point.x}
              y1={0}
              y2={CHART_VIEWBOX_HEIGHT}
              className={css.crosshair}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {hover ? (
          <div
            className={css.tooltip}
            data-align={tooltipAlign}
            style={{ left: `${tooltipLeftPct}%` }}
            role="status"
            aria-live="polite"
          >
            <span className={css.tooltipLabel}>{hover.point.label}</span>
            <span className={css.tooltipValue}>
              {formatCompactNumber(hover.point.value)} tokens
            </span>
          </div>
        ) : null}
      </div>
      <div className={css.axis} aria-hidden="true">
        <span>{points.length - 1}d ago</span>
        {peakLabel ? <span className={css.axisPeak}>{peakLabel}</span> : null}
        <span>today</span>
      </div>
    </div>
  );
}

/**
 * Build a smooth Bezier path through the given points using Catmull-Rom
 * to cubic-Bezier conversion. Single pass, no overshoot beyond the data
 * envelope at the resolutions we use here.
 */
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  }
  const fmt = (value: number) => value.toFixed(2);
  const segments = [`M${fmt(points[0].x)},${fmt(points[0].y)}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    segments.push(
      `C${fmt(cp1x)},${fmt(cp1y)} ${fmt(cp2x)},${fmt(cp2y)} ${fmt(p2.x)},${fmt(p2.y)}`,
    );
  }
  return segments.join(' ');
}
