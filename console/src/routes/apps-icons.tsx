import type { ReactNode, SVGProps } from 'react';
import type { AppCategory } from '../api/apps';

type IconProps = SVGProps<SVGSVGElement>;

function Svg(props: IconProps & { children: ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="100%"
      height="100%"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 2x2 grid — the "Apps" launcher icon used in the chat sidebar nav. */
export function AppsGridIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

function AppsWebsitesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17" />
      <path d="M6.5 7h.01M8.5 7h.01" />
    </Svg>
  );
}

function DocumentsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M9.5 12h5M9.5 15h5M9.5 9h2" />
    </Svg>
  );
}

function GamesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="8" width="18" height="9" rx="4.5" />
      <path d="M7 11.5v3M5.5 13h3" />
      <path d="M15.5 12h.01M17.5 14h.01" />
    </Svg>
  );
}

function ProductivityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3 5 13h6l-1 8 8-10h-6z" />
    </Svg>
  );
}

function CreativeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 21c0-3 2-4 4-4 1.5 0 2.5 1 2.5 2.5S8 21 6 21z" />
      <path d="M9 17 19.5 6.5a2.1 2.1 0 0 0-3-3L6 14" />
    </Svg>
  );
}

function QuizIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4.5h6V7H9z" />
      <path d="m8.5 12 1.5 1.5 2.5-3" />
      <path d="M14.5 12.5h2" />
    </Svg>
  );
}

function ScratchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v6M9 7h6" />
      <path
        d="M6 16.5 7 19l2.5 1L7 21l-1 2.5L5 21l-2.5-1L5 19z"
        transform="translate(0 -3)"
      />
      <path d="M17 13l.7 1.8 1.8.7-1.8.7L17 18l-.7-1.8-1.8-.7 1.8-.7z" />
    </Svg>
  );
}

const CATEGORY_ICONS: Record<AppCategory, (props: IconProps) => ReactNode> = {
  apps: AppsWebsitesIcon,
  documents: DocumentsIcon,
  games: GamesIcon,
  productivity: ProductivityIcon,
  creative: CreativeIcon,
  quiz: QuizIcon,
  scratch: ScratchIcon,
};

export function CategoryIcon(props: { category: AppCategory } & IconProps) {
  const { category, ...rest } = props;
  const Icon = CATEGORY_ICONS[category] ?? AppsWebsitesIcon;
  return <Icon {...rest} />;
}
