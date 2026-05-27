import { Icon, type IconProps } from './base';

export function ChevronDown(props: IconProps) {
  return (
    <Icon
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}
