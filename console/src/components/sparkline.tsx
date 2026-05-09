import styles from './sparkline.module.css';

const DEFAULT_HEIGHT = 40;
const VIEWBOX_WIDTH = 200;

export interface SparklinePoint {
  label: string;
  value: number;
}

export function Sparkline(props: {
  points: SparklinePoint[];
  height?: number;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
}) {
  const height = props.height ?? DEFAULT_HEIGHT;

  if (props.points.length < 2) {
    return (
      <div
        className={styles.placeholder}
        style={{ height }}
        aria-hidden="true"
      />
    );
  }

  const max = Math.max(...props.points.map((p) => p.value));
  const stepX = VIEWBOX_WIDTH / (props.points.length - 1);
  const formatValue = props.formatValue ?? String;
  const positions = props.points.map((point, index) => ({
    x: index * stepX,
    // When max is 0 every value is 0; pin to the baseline so the path is
    // valid SVG (no NaN from division-by-zero).
    y: max === 0 ? height : height - (point.value / max) * height,
    point,
  }));

  const linePath = `M${positions
    .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' L')}`;
  const areaPath = `${linePath} L${VIEWBOX_WIDTH},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
      preserveAspectRatio="none"
      className={styles.svg}
      style={{ height }}
      role="img"
      aria-label={props.ariaLabel}
    >
      <path d={areaPath} className={styles.area} />
      <path d={linePath} className={styles.line} />
      {positions.map(({ x, point }) => (
        <rect
          key={point.label}
          x={x - stepX / 2}
          y={0}
          width={stepX}
          height={height}
          className={styles.hit}
        >
          <title>{`${point.label}: ${formatValue(point.value)}`}</title>
        </rect>
      ))}
    </svg>
  );
}
