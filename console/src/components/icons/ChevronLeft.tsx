import { Icon, type IconProps } from './base';

export function ChevronLeft(props: IconProps) {
  return (
    <Icon
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}
