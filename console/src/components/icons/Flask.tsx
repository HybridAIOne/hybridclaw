import { Icon, type IconProps } from './base';

export function Flask(props: IconProps) {
  return (
    <Icon strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v5.2l-4.4 8.2A3 3 0 0 0 8.2 21h7.6a3 3 0 0 0 2.6-4.6L14 8.2V3" />
      <path d="M8 14h8" />
      <path d="M9.5 17h5" />
    </Icon>
  );
}
