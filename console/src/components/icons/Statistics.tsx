import { Icon, type IconProps } from './base';

export function Statistics(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <rect x="7" y="12" width="3" height="7" />
      <rect x="12" y="8" width="3" height="11" />
      <rect x="17" y="14" width="3" height="5" />
    </Icon>
  );
}
