import { Icon, type IconProps } from './base';

export function Admin(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7 4v10l-7 4-7-4V7l7-4z" />
      <path d="M12 8v8" />
      <path d="M8.5 10 12 8l3.5 2" />
    </Icon>
  );
}
