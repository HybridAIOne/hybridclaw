/**
 * Agent scope picker — the allowlist editor shared by the skills and tools
 * cards on the agent configuration tab.
 *
 * The control has exactly two states and never blurs them: `null` means "no
 * allowlist" (everything available now and everything added later), and an
 * array means "only these". The mode cards make the choice explicit;
 * "Selected only" starts empty (or restores the selection stashed when the
 * mode last flipped to "all"), and nothing persists until the page is saved.
 *
 * Restricted mode shows only the enabled entries; additions go through a
 * command-palette dialog that searches the catalog (and, for tools, accepts
 * exact names the catalog cannot list, such as MCP tools).
 *
 * NOT a global enable/disable surface (`/admin/skills` and `tools.disabled`
 * own that); entries this picker offers may still be off fleet-wide.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/button';
import paletteStyles from '../components/command-palette.module.css';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { Search } from '../components/icons';
import { cx } from '../lib/cx';
import styles from './agent-config.module.css';

export interface AgentScopeItem {
  id: string;
  label: string;
  description?: string;
  /** Short muted labels shown after the name (for example `mcp`, `off`). */
  badges?: string[];
}

export interface AgentScopeGroup {
  label: string;
  items: AgentScopeItem[];
}

interface CatalogEntry extends AgentScopeItem {
  group: string;
}

type PaletteRow =
  | { kind: 'catalog'; entry: CatalogEntry }
  | { kind: 'custom'; name: string };

const MAX_PALETTE_ROWS = 50;

function matchesQuery(entry: CatalogEntry, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    entry.id.toLowerCase().includes(needle) ||
    entry.label.toLowerCase().includes(needle) ||
    entry.group.toLowerCase().includes(needle) ||
    (entry.description || '').toLowerCase().includes(needle)
  );
}

export function AgentScopePicker(props: {
  title: string;
  description: string;
  allLabel: string;
  /** One-liner for the "all" mode card. */
  allNote: string;
  /** One-liner for the "selected only" mode card. */
  restrictedNote: string;
  searchPlaceholder: string;
  groups: AgentScopeGroup[];
  /** `null` keeps every entry available, including entries added later. */
  value: string[] | null;
  loading?: boolean;
  onChange: (value: string[] | null) => void;
  /** Offers a free-text row for entries the catalog cannot list (MCP tools). */
  allowCustomEntries?: boolean;
}) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  /** Last custom selection, restored when flipping back from "all". */
  const [stash, setStash] = useState<string[] | null>(null);

  const catalog = useMemo<CatalogEntry[]>(
    () =>
      props.groups.flatMap((group) =>
        group.items.map((item) => ({ ...item, group: group.label })),
      ),
    [props.groups],
  );
  const catalogById = useMemo(
    () => new Map(catalog.map((entry) => [entry.id, entry])),
    [catalog],
  );
  const unrestricted = props.value === null;
  const selected = props.value ?? [];
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const totalCount = catalog.length;

  function setSelection(next: Set<string>): void {
    const ordered = catalog
      .map((entry) => entry.id)
      .filter((id) => next.has(id));
    const extras = [...next].filter((id) => !catalogById.has(id));
    props.onChange([...ordered, ...extras]);
  }

  function addEntry(id: string): void {
    setSelection(new Set([...selectedIds, id]));
  }

  function removeEntry(id: string): void {
    const next = new Set(selectedIds);
    next.delete(id);
    setSelection(next);
  }

  const paletteRows = useMemo<PaletteRow[]>(() => {
    const trimmed = query.trim();
    const rows: PaletteRow[] = catalog
      .filter(
        (entry) => !selectedIds.has(entry.id) && matchesQuery(entry, trimmed),
      )
      .slice(0, MAX_PALETTE_ROWS)
      .map((entry) => ({ kind: 'catalog', entry }));
    if (
      props.allowCustomEntries &&
      trimmed &&
      !catalogById.has(trimmed) &&
      !selectedIds.has(trimmed)
    ) {
      rows.push({ kind: 'custom', name: trimmed });
    }
    return rows;
  }, [catalog, catalogById, query, selectedIds, props.allowCustomEntries]);

  const activeRow = Math.min(activeIndex, Math.max(paletteRows.length - 1, 0));

  function closePalette(): void {
    setAddOpen(false);
    setQuery('');
    setActiveIndex(0);
  }

  function pickRow(row: PaletteRow): void {
    addEntry(row.kind === 'catalog' ? row.entry.id : row.name);
    if (row.kind === 'custom') setQuery('');
    inputRef.current?.focus();
  }

  function handlePaletteKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(
        paletteRows.length === 0 ? 0 : (activeRow + 1) % paletteRows.length,
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(
        paletteRows.length === 0
          ? 0
          : (activeRow - 1 + paletteRows.length) % paletteRows.length,
      );
    } else if (event.key === 'Enter') {
      const row = paletteRows[activeRow];
      if (!row) return;
      event.preventDefault();
      pickRow(row);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  }

  function chooseAll(): void {
    if (unrestricted) return;
    setStash(selected);
    props.onChange(null);
  }

  function chooseCustom(): void {
    if (!unrestricted) return;
    props.onChange(stash ?? []);
  }

  const lowerTitle = props.title.toLowerCase();

  return (
    <section className={styles.scopeCard}>
      <header className={styles.scopeHeader}>
        <div>
          <h3 className={styles.scopeTitle}>{props.title}</h3>
          <p className="supporting-text">{props.description}</p>
        </div>
      </header>

      <fieldset
        className={styles.scopeModes}
        aria-label={`${props.title} scope`}
      >
        <button
          type="button"
          aria-pressed={unrestricted}
          className={cx(
            styles.scopeMode,
            unrestricted && styles.scopeModeActive,
          )}
          onClick={chooseAll}
        >
          <span className={styles.scopeModeTitle}>
            <span className={styles.scopeModeDot} aria-hidden="true" />
            <strong>{props.allLabel}</strong>
          </span>
          <small>{props.allNote}</small>
        </button>
        <button
          type="button"
          aria-pressed={!unrestricted}
          className={cx(
            styles.scopeMode,
            !unrestricted && styles.scopeModeActive,
          )}
          onClick={chooseCustom}
        >
          <span className={styles.scopeModeTitle}>
            <span className={styles.scopeModeDot} aria-hidden="true" />
            <strong>Selected only</strong>
          </span>
          <small>{props.restrictedNote}</small>
        </button>
      </fieldset>

      {props.loading ? (
        <div className="empty-state">Loading catalog...</div>
      ) : unrestricted ? null : (
        <>
          <div className={styles.scopeListActions}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddOpen(true)}
            >
              Add {lowerTitle}…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selected.length === 0}
              onClick={() => props.onChange([])}
            >
              Clear all
            </Button>
            <span className={styles.scopeCount}>
              {selected.length} of {totalCount} selected
            </span>
          </div>

          {selected.length === 0 ? (
            <div className="empty-state">
              Nothing selected — this agent gets no {lowerTitle}.
            </div>
          ) : (
            <div className={styles.scopeList}>
              {selected.map((id) => {
                const entry = catalogById.get(id);
                return (
                  <div className={styles.scopeRow} key={id}>
                    <span className={styles.scopeItemText}>
                      <span className={styles.scopeItemName}>
                        {entry?.label ?? id}
                        {entry?.badges?.map((badge) => (
                          <em className={styles.scopeBadge} key={badge}>
                            {badge}
                          </em>
                        ))}
                      </span>
                      {entry?.description ? (
                        <small>{entry.description}</small>
                      ) : null}
                    </span>
                    {entry ? (
                      <span className={styles.scopeRowGroup}>
                        {entry.group}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={styles.scopeRemove}
                      aria-label={`Remove ${id}`}
                      onClick={() => removeEntry(id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => (open ? setAddOpen(true) : closePalette())}
      >
        <DialogContent
          size="lg"
          className={paletteStyles.dialog}
          initialFocus={inputRef}
        >
          <DialogHeader visuallyHidden>
            <DialogTitle>Add {lowerTitle}</DialogTitle>
            <DialogDescription>
              Search the catalog and pick entries to enable for this agent.
            </DialogDescription>
          </DialogHeader>
          <div className={paletteStyles.searchBox}>
            <Search width={18} height={18} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handlePaletteKeyDown}
              placeholder={props.searchPlaceholder}
              aria-label={props.searchPlaceholder}
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={
                paletteRows[activeRow]
                  ? `${listboxId}-option-${activeRow}`
                  : undefined
              }
            />
          </div>
          <div id={listboxId} className={paletteStyles.results} role="listbox">
            {paletteRows.map((row, index) => (
              <button
                id={`${listboxId}-option-${index}`}
                key={
                  row.kind === 'catalog' ? row.entry.id : `custom:${row.name}`
                }
                type="button"
                role="option"
                aria-selected={index === activeRow}
                className={
                  index === activeRow ? paletteStyles.active : undefined
                }
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pickRow(row)}
              >
                {row.kind === 'catalog' ? (
                  <>
                    <span>
                      <strong>
                        {row.entry.label}
                        {row.entry.badges?.map((badge) => (
                          <em className={styles.scopeBadge} key={badge}>
                            {badge}
                          </em>
                        ))}
                      </strong>
                      {row.entry.description ? (
                        <small>{row.entry.description}</small>
                      ) : null}
                    </span>
                    <em>{row.entry.group}</em>
                  </>
                ) : (
                  <>
                    <span>
                      <strong>Add “{row.name}”</strong>
                      <small>Not in the catalog — enabled by exact name.</small>
                    </span>
                    <em>custom</em>
                  </>
                )}
              </button>
            ))}
            {paletteRows.length === 0 ? (
              <div className={paletteStyles.empty}>
                {query.trim()
                  ? `Nothing matches “${query.trim()}”.`
                  : `Every catalog entry is already selected.`}
              </div>
            ) : null}
          </div>
          <div className={paletteStyles.hint}>
            <span>↑↓ Navigate</span>
            <span>↵ Add</span>
            <span>Esc Done</span>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
