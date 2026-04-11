import { Icon, type IconProps } from './base';

export function Jobs(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
      <path d="M8 17h7" />
    </Icon>
  );
}
