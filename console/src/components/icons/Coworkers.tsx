import { Icon, type IconProps } from './base';

export function Coworkers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
      <circle cx="12" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      <path d="M2 21v-2a4 4 0 0 1 3-3.87" />
      <path d="M8 3.13a4 4 0 0 0 0 7.75" />
    </Icon>
  );
}
