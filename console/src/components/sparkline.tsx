import styles from './sparkline.module.css';

const DEFAULT_HEIGHT = 40;
const VIEWBOX_WIDTH = 200;

export function Sparkline(props: {
  values: number[];
  height?: number;
  ariaLabel?: string;
}) {
  const height = props.height ?? DEFAULT_HEIGHT;
  if (props.values.length < 2) {
    // Not enough points to draw a line. Render a presentational placeholder
    // so the layout doesn't jump when data starts arriving.
    return (
      <div
        className={styles.placeholder}
        style={{ height }}
        aria-hidden="true"
      />
    );
  }

  const max = Math.max(...props.values);
  const stepX = VIEWBOX_WIDTH / (props.values.length - 1);
  const points = props.values.map((value, index) => {
    const x = index * stepX;
    // When max is 0 every value is 0; pin to the baseline so the path is
    // valid SVG (no NaN from division-by-zero).
    const y = max === 0 ? height : height - (value / max) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePath = `M${points.join(' L')}`;
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
    </svg>
  );
}
