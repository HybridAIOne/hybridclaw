import { Icon, type IconProps } from './base';

export function Menu(props: IconProps) {
  return (
    <Icon strokeWidth="1.8" {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Icon>
  );
}
