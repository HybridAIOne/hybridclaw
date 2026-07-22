import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  SETTINGS_REGISTRY,
  settingAnchor,
  settingsSearchText,
} from '../lib/settings-registry';
import styles from './command-palette.module.css';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Search } from './icons';
import { SIDEBAR_NAV_GROUPS } from './sidebar/navigation';

interface CommandEntry {
  id: string;
  label: string;
  detail: string;
  group: 'Pages' | 'Settings';
  href: string;
  searchText: string;
}

const PAGE_COMMANDS: ReadonlyArray<CommandEntry> = SIDEBAR_NAV_GROUPS.flatMap(
  (group) =>
    group.items.map((item) => ({
      id: `page:${item.to}`,
      label: item.label,
      detail: group.label,
      group: 'Pages' as const,
      href: item.to,
      searchText: `${item.label} ${group.label} ${item.to}`.toLowerCase(),
    })),
);

const SETTING_COMMANDS: ReadonlyArray<CommandEntry> = SETTINGS_REGISTRY.map(
  (entry) => ({
    id: `setting:${entry.path}`,
    label: entry.label,
    detail: entry.path,
    group: 'Settings' as const,
    href:
      entry.owner?.to ??
      `/admin/config?section=${encodeURIComponent(entry.section)}#${settingAnchor(entry.path)}`,
    searchText: settingsSearchText(entry),
  }),
);

const COMMANDS = [...PAGE_COMMANDS, ...SETTING_COMMANDS];

function fuzzyScore(haystack: string, query: string): number | null {
  const directIndex = haystack.indexOf(query);
  if (directIndex !== -1) return directIndex;

  let queryIndex = 0;
  let spread = 0;
  let previousMatch = -1;
  for (
    let index = 0;
    index < haystack.length && queryIndex < query.length;
    index++
  ) {
    if (haystack[index] !== query[queryIndex]) continue;
    if (previousMatch !== -1) spread += index - previousMatch - 1;
    previousMatch = index;
    queryIndex++;
  }
  return queryIndex === query.length ? 100 + spread : null;
}

function searchCommands(query: string): ReadonlyArray<CommandEntry> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return PAGE_COMMANDS;

  return COMMANDS.map((entry) => ({
    entry,
    score: fuzzyScore(entry.searchText, normalized),
  }))
    .filter(
      (result): result is { entry: CommandEntry; score: number } =>
        result.score !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score ||
        (left.entry.group === right.entry.group
          ? left.entry.label.localeCompare(right.entry.label)
          : left.entry.group === 'Pages'
            ? -1
            : 1),
    )
    .slice(0, 40)
    .map((result) => result.entry);
}

export function CommandPalette() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => searchCommands(query), [query]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }
      event.preventDefault();
      setOpen((current) => !current);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const select = (entry: CommandEntry) => {
    setOpen(false);
    const target = new URL(entry.href, window.location.origin);
    window.history.pushState(
      window.history.state,
      '',
      `${target.pathname}${target.search}${target.hash}`,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) =>
        results.length === 0 ? 0 : (current + 1) % results.length,
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) =>
        results.length === 0
          ? 0
          : (current - 1 + results.length) % results.length,
      );
    } else if (event.key === 'Enter') {
      const entry = results[activeIndex];
      if (!entry) return;
      event.preventDefault();
      select(entry);
    }
  };

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-label="Search pages and settings"
      >
        <Search width={16} height={16} />
        <span className={styles.triggerLabel}>Search</span>
        <kbd className={styles.triggerKey}>⌘K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          size="lg"
          className={styles.dialog}
          initialFocus={inputRef}
        >
          <DialogHeader visuallyHidden>
            <DialogTitle>Search pages and settings</DialogTitle>
            <DialogDescription>
              Navigate to an admin page or an individual runtime setting.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.searchBox}>
            <Search width={18} height={18} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Search pages and settings…"
              aria-label="Search pages and settings"
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-results"
              aria-activedescendant={
                results[activeIndex]
                  ? `command-${results[activeIndex]?.id.replace(/[^a-z0-9]/giu, '-')}`
                  : undefined
              }
            />
          </div>
          <div
            id="command-palette-results"
            className={styles.results}
            role="listbox"
          >
            {results.map((entry, index) => (
              <button
                id={`command-${entry.id.replace(/[^a-z0-9]/giu, '-')}`}
                key={entry.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? styles.active : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(entry)}
              >
                <span>
                  <strong>{entry.label}</strong>
                  <small>{entry.detail}</small>
                </span>
                <em>{entry.group}</em>
              </button>
            ))}
            {results.length === 0 ? (
              <div className={styles.empty}>No matching pages or settings.</div>
            ) : null}
          </div>
          <div className={styles.hint}>
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
