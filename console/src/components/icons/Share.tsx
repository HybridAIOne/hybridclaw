import { Icon, type IconProps } from './base';

export function Share(props: IconProps) {
  return (
    <Icon strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 10.6l6.8-4.2" />
      <path d="M8.6 13.4l6.8 4.2" />
    </Icon>
  );
}
