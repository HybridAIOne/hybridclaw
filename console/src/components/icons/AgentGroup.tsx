import { Icon, type IconProps } from './base';

export function AgentGroup(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="4" />
      <circle cx="17" cy="9" r="3" />
      <path d="M3 21v-2a6 6 0 0 1 12 0v2" />
      <path d="M14 17.5a5 5 0 0 1 7 4.5" />
    </Icon>
  );
}
