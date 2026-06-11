import { Icon, type IconProps } from './base';

export function Harness(props: IconProps) {
  return (
    <Icon strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 4 5 11v8" />
      <path d="m16 4 3 7v8" />
      <path d="M8 4h8" />
      <path d="M9 6.5 12 12l3-5.5" />
      <path d="M7 13h10" />
      <path d="M6 17h12" />
      <circle cx="12" cy="12" r="1.6" />
    </Icon>
  );
}
