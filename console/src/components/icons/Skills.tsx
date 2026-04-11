import { Icon, type IconProps } from './base';

export function Skills(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3h7v7" />
      <path d="M10 14 21 3" />
      <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    </Icon>
  );
}
