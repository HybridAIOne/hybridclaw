import { Icon, type IconProps } from './base';

export function Circle(props: IconProps) {
  return (
    <Icon fill="currentColor" stroke="none" {...props}>
      <circle cx="12" cy="12" r="5" />
    </Icon>
  );
}
