import { Icon, type IconProps } from './base';

export function Secrets(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}
