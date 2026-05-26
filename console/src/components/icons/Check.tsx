import { Icon, type IconProps } from './base';

export function Check(props: IconProps) {
  return (
    <Icon
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4.5 12.5l5 5L19.5 6.5" />
    </Icon>
  );
}
