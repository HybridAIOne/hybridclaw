import { Icon, type IconProps } from './base';

export function Models(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="6" rx="6.5" ry="2.5" />
      <path d="M5.5 6v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6" />
      <path d="M5.5 12v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-6" />
    </Icon>
  );
}
