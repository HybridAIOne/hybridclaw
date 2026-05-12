import { Icon, type IconProps } from './base';

export function Search(props: IconProps) {
  return (
    <Icon strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}
