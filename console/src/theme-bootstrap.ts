export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'hybridclaw-theme';

export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'system';
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function resolveTheme(
  theme: Theme,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return theme === 'system' ? systemTheme : theme;
}

export function applyResolvedTheme(resolvedTheme: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
}

export function bootstrapTheme() {
  const theme = getStoredTheme();
  const resolved = resolveTheme(theme, getSystemTheme());
  applyResolvedTheme(resolved);
  return { theme, resolved };
}
