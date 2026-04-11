import { Icon, type IconProps } from './base';

export function Dashboard(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13.5a8 8 0 1 1 16 0" />
      <path d="M12 13l4-4" />
      <path d="M12 13v.01" />
    </Icon>
  );
}
