import { useSyncExternalStore } from 'react';
import {
  applyResolvedTheme,
  getStoredTheme,
  getSystemTheme,
  type ResolvedTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from './theme-bootstrap';

type ThemeSnapshot = {
  theme: Theme;
  resolved: ResolvedTheme;
};

const listeners = new Set<() => void>();

let themePreference: Theme = getStoredTheme();
let systemTheme: ResolvedTheme = getSystemTheme();
let mediaQueryList: MediaQueryList | null = null;
let initialized = false;
let snapshot: ThemeSnapshot = createSnapshot();

function createSnapshot(): ThemeSnapshot {
  return {
    theme: themePreference,
    resolved: resolveTheme(themePreference, systemTheme),
  };
}

function emitChange() {
  snapshot = createSnapshot();
  applyResolvedTheme(snapshot.resolved);
  for (const listener of listeners) listener();
}

function handleSystemThemeChange(event: MediaQueryListEvent) {
  systemTheme = event.matches ? 'dark' : 'light';
  emitChange();
}

function handleStorage(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY) return;
  themePreference = getStoredTheme();
  emitChange();
}

export function initThemeStore() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  themePreference = getStoredTheme();
  systemTheme = getSystemTheme();
  snapshot = createSnapshot();
  applyResolvedTheme(snapshot.resolved);
  mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQueryList.addEventListener('change', handleSystemThemeChange);
  window.addEventListener('storage', handleStorage);
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

export function getThemePreference(): Theme {
  return snapshot.theme;
}

export function getResolvedTheme(): ResolvedTheme {
  return snapshot.resolved;
}

export function setTheme(theme: Theme) {
  themePreference = theme;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
  emitChange();
}

export function subscribeTheme(listener: () => void) {
  initThemeStore();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  return useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot,
  );
}
