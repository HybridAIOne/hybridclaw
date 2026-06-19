import { Icon, type IconProps } from './base';

export function ChevronRight(props: IconProps) {
  return (
    <Icon
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}
