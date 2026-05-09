import { useId, useMemo, useState } from 'react';
import styles from './sparkline.module.css';

const DEFAULT_HEIGHT = 56;
const VIEWBOX_WIDTH = 320;
const BAR_GAP = 1;
const MIN_BAR_HEIGHT = 1.5;

export interface SparklinePoint {
  label: string;
  value: number;
}

export interface SparklineProps {
  points: SparklinePoint[];
  height?: number;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  startLabel?: string;
  endLabel?: string;
  middleLabel?: string;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
  point: SparklinePoint;
}

/**
 * Compresses heavy outliers in the daily-tokens trend so the body of the
 * data stays visible. We use a sqrt curve rather than a log because zeros
 * are common and meaningful (no usage that day), and sqrt(0) = 0 keeps
 * the baseline honest.
 */
function scaleHeight(value: number, max: number, height: number): number {
  if (max <= 0 || value <= 0) return 0;
  const ratio = Math.sqrt(value / max);
  const scaled = ratio * height;
  return Math.max(scaled, MIN_BAR_HEIGHT);
}

export function Sparkline(props: SparklineProps) {
  const height = props.height ?? DEFAULT_HEIGHT;
  const formatValue = props.formatValue ?? String;
  const id = useId();
  const [hover, setHover] = useState<HoverState | null>(null);

  const points = props.points;
  const count = points.length;

  const layout = useMemo(() => {
    if (count === 0) return null;
    const stepX = VIEWBOX_WIDTH / count;
    const barWidth = Math.max(stepX - BAR_GAP, 0.5);
    const max = points.reduce((acc, p) => (p.value > acc ? p.value : acc), 0);
    const peakIndex = max > 0 ? points.findIndex((p) => p.value === max) : -1;
    const bars = points.map((point, index) => {
      const barHeight = scaleHeight(point.value, max, height);
      const x = index * stepX + BAR_GAP / 2;
      const y = height - barHeight;
      return {
        index,
        point,
        x,
        y,
        width: barWidth,
        height: barHeight,
        centerX: x + barWidth / 2,
        isPeak: index === peakIndex && point.value > 0,
        isLast: index === count - 1,
      };
    });
    return { bars, max, stepX, barWidth };
  }, [points, count, height]);

  if (!layout || count === 0) {
    return (
      <div
        className={styles.placeholder}
        style={{ height }}
        aria-hidden="true"
      />
    );
  }

  const { bars } = layout;
  const startLabel = props.startLabel ?? `${count - 1}d ago`;
  const endLabel = props.endLabel ?? 'today';

  function handleMove(
    event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>,
  ) {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const clampedRatio = Math.min(Math.max(ratio, 0), 0.9999);
    const rawIndex = Math.floor(clampedRatio * count);
    const index = Math.min(Math.max(rawIndex, 0), count - 1);
    const bar = bars[index];
    if (!bar) return;
    setHover({
      index,
      x: bar.centerX,
      y: bar.y,
      point: bar.point,
    });
  }

  function handleLeave() {
    setHover(null);
  }

  const active = hover;
  const tooltipLeftPct = active ? (active.x / VIEWBOX_WIDTH) * 100 : 0;
  // Flip the tooltip alignment near the right edge so it doesn't clip.
  const tooltipAlign = !active
    ? 'start'
    : tooltipLeftPct > 75
      ? 'end'
      : tooltipLeftPct < 18
        ? 'start'
        : 'center';

  return (
    <div className={styles.root} data-has-hover={active ? 'true' : 'false'}>
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
        preserveAspectRatio="none"
        className={styles.svg}
        style={{ height }}
        role="img"
        aria-label={props.ariaLabel}
        aria-describedby={`${id}-desc`}
        onPointerMove={handleMove}
        onPointerLeave={handleLeave}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <desc id={`${id}-desc`}>
          {props.ariaLabel ?? 'Daily values for the selected window.'}
        </desc>
        <defs>
          <linearGradient
            id={`${id}-fill`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" className={styles.gradientTop} />
            <stop offset="100%" className={styles.gradientBottom} />
          </linearGradient>
        </defs>
        <line
          x1={0}
          x2={VIEWBOX_WIDTH}
          y1={height - 0.5}
          y2={height - 0.5}
          className={styles.baseline}
          vectorEffect="non-scaling-stroke"
        />
        {bars.map((bar) => {
          const className = [
            styles.bar,
            bar.isPeak ? styles.barPeak : '',
            bar.isLast ? styles.barToday : '',
            active?.index === bar.index ? styles.barActive : '',
            bar.point.value === 0 ? styles.barEmpty : '',
          ]
            .filter(Boolean)
            .join(' ');
          const useGradient =
            bar.point.value > 0 &&
            !bar.isLast &&
            !(active?.index === bar.index);
          return (
            <rect
              key={`${bar.point.label}-${bar.index}`}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={Math.max(bar.height, bar.point.value === 0 ? 0 : 0)}
              rx={1}
              className={className}
              style={useGradient ? { fill: `url(#${id}-fill)` } : undefined}
            >
              <title>{`${bar.point.label}: ${formatValue(bar.point.value)}`}</title>
            </rect>
          );
        })}
        {active ? (
          <line
            x1={active.x}
            x2={active.x}
            y1={0}
            y2={height}
            className={styles.crosshair}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className={styles.axis} aria-hidden="true">
        <span>{startLabel}</span>
        {props.middleLabel ? (
          <span className={styles.axisMiddle}>{props.middleLabel}</span>
        ) : null}
        <span>{endLabel}</span>
      </div>
      {active ? (
        <div
          className={styles.tooltip}
          data-align={tooltipAlign}
          style={{ left: `${tooltipLeftPct}%` }}
          role="status"
          aria-live="polite"
        >
          <span className={styles.tooltipLabel}>{active.point.label}</span>
          <span className={styles.tooltipValue}>
            {formatValue(active.point.value)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
