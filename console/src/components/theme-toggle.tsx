import { setTheme, useTheme } from '../theme';
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from './dropdown/index';

const SunIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="5" />
    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
  </svg>
);

const MoonIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const SystemIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

function ThemeIcon({ theme }: { theme: 'light' | 'dark' | 'system' }) {
  if (theme === 'light') return <SunIcon />;
  if (theme === 'dark') return <MoonIcon />;
  return <SystemIcon />;
}

const THEME_OPTIONS: { value: 'light' | 'dark' | 'system'; label: string }[] =
  [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

export function ThemeToggle(props: { labelClassName?: string }) {
  const { theme, resolved } = useTheme();
  const label = THEME_OPTIONS.find((o) => o.value === theme)?.label ?? theme;

  return (
    <Dropdown>
      <DropdownTrigger
        className="theme-toggle-trigger"
        aria-label={`Theme: ${theme} (${resolved})`}
        title="Change theme"
      >
        <ThemeIcon theme={theme} />
        <span className={props.labelClassName}>{label}</span>
      </DropdownTrigger>
      <DropdownContent className="theme-toggle-menu" align="end">
        {THEME_OPTIONS.map((option) => (
          <DropdownItem
            key={option.value}
            className="theme-toggle-option"
            active={theme === option.value}
            onSelect={() => setTheme(option.value)}
          >
            <ThemeIcon theme={option.value} />
            <span>{option.label}</span>
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}
