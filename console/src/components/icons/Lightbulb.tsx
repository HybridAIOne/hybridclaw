import { Icon, type IconProps } from './base';

export function Lightbulb(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.74V16a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.26A7 7 0 0 0 12 2z" />
    </Icon>
  );
}
