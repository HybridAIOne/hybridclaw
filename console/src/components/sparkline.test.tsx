import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline, type SparklinePoint } from './sparkline';

function buildPoints(values: number[]): SparklinePoint[] {
  return values.map((value, index) => ({
    label: `Day ${index + 1}`,
    value,
  }));
}

describe('Sparkline', () => {
  it('renders a placeholder when there is no data', () => {
    const { container } = render(<Sparkline points={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a bar per data point with native title tooltips', () => {
    const points = buildPoints([0, 5, 10, 0, 25]);
    render(<Sparkline points={points} ariaLabel="Tokens per day" />);
    const svg = screen.getByRole('img', { name: 'Tokens per day' });
    expect(svg.querySelectorAll('rect').length).toBe(points.length);
    expect(svg.querySelectorAll('title').length).toBe(points.length);
  });

  it('still gives non-peak days a visible amplitude when an outlier dominates', () => {
    // Recreate the dense-outlier failure mode: one big day, the rest small.
    const heavy = buildPoints([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      68_000_000, 0, 0, 0, 0, 0,
    ]);
    render(<Sparkline points={heavy} ariaLabel="dense outlier" />);
    const svg = screen.getByRole('img', { name: 'dense outlier' });
    const rects = Array.from(svg.querySelectorAll('rect'));
    const heightOf = (rect: Element) =>
      Number.parseFloat(rect.getAttribute('height') ?? '0');
    const peakHeight = heightOf(rects[24]);
    const smallHeight = heightOf(rects[12]);
    // Sqrt scaling keeps the small day from collapsing to a hairline:
    // its bar must be measurably tall yet still well below the peak.
    expect(peakHeight).toBeGreaterThan(0);
    expect(smallHeight).toBeGreaterThan(0.5);
    expect(smallHeight).toBeLessThan(peakHeight);
  });

  it('formats hovered values via the supplied formatter', () => {
    const points = buildPoints([1, 2, 3, 4, 5]);
    const { container } = render(
      <Sparkline
        points={points}
        ariaLabel="hover-test"
        formatValue={(value) => `${value} tokens`}
      />,
    );
    const svg = screen.getByRole('img', { name: 'hover-test' });
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 50,
        width: 200,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => '',
      }),
      configurable: true,
    });
    fireEvent.mouseMove(svg, {
      clientX: 199,
      clientY: 5,
      bubbles: true,
    });
    const tooltip = container.querySelector('[role="status"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent ?? '').toContain('Day 5');
    expect(tooltip?.textContent ?? '').toContain('5 tokens');
  });

  it('renders start and end axis labels for direction context', () => {
    const points = buildPoints([1, 2, 3]);
    render(<Sparkline points={points} startLabel="30d ago" endLabel="today" />);
    expect(screen.getByText('30d ago')).toBeTruthy();
    expect(screen.getByText('today')).toBeTruthy();
  });
});
