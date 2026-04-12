import { Icon, type IconProps } from './base';

export function Plugins(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3v6" />
      <path d="M15 15v6" />
      <path d="M15 3v2" />
      <path d="M9 19v2" />
      <path d="M8 8h2a3 3 0 1 1 0 6H8a3 3 0 1 1 0-6Z" />
      <path d="M14 10h2a3 3 0 1 1 0 6h-2a3 3 0 1 1 0-6Z" />
    </Icon>
  );
}
