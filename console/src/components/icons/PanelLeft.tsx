import { Icon, type IconProps } from './base';

export function PanelLeft(props: IconProps) {
  return (
    <Icon strokeWidth="1.8" {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Icon>
  );
}
