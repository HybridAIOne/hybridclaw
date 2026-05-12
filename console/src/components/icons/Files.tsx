import { Icon, type IconProps } from './base';

export function Files(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v12" />
      <path d="M19 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h11z" />
      <path d="M15 2v4h4" />
      <path d="M10 12h5" />
      <path d="M10 16h5" />
    </Icon>
  );
}
