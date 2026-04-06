import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

export function Icon({
  children,
  viewBox = '0 0 24 24',
  fill = 'none',
  stroke = 'currentColor',
  strokeWidth = '2',
  ...props
}: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={viewBox}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      {...props}
    >
      {children}
    </svg>
  );
}
