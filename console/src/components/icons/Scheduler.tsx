import { Icon, type IconProps } from './base';

export function Scheduler(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}
