/**
 * Agent scope picker — the allowlist editor shared by the skills and tools
 * cards on the agent configuration tab.
 *
 * The control has exactly two states and never blurs them: `null` means "no
 * allowlist" (everything available now and everything added later), and an
 * array means "only these". Unchecking an entry while in the `null` state
 * snapshots the catalog minus that entry, so narrowing is always explicit.
 *
 * NOT a global enable/disable surface (`/admin/skills` and `tools.disabled`
 * own that); entries this picker offers may still be off fleet-wide.
 */
import { useMemo, useState } from 'react';
import { Button } from '../components/button';
import { Checkbox } from '../components/checkbox';
import { Input } from '../components/input';
import { SegmentedToggle } from '../components/ui';
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

function matchesQuery(item: AgentScopeItem, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    item.id.toLowerCase().includes(needle) ||
    item.label.toLowerCase().includes(needle) ||
    (item.description || '').toLowerCase().includes(needle)
  );
}

export function AgentScopePicker(props: {
  title: string;
  description: string;
  allLabel: string;
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
  const [query, setQuery] = useState('');
  const [customEntry, setCustomEntry] = useState('');

  const catalogIds = useMemo(
    () => props.groups.flatMap((group) => group.items.map((item) => item.id)),
    [props.groups],
  );
  const selectedIds = useMemo(
    () => new Set(props.value ?? catalogIds),
    [props.value, catalogIds],
  );
  const unrestricted = props.value === null;

  const visibleGroups = useMemo(
    () =>
      props.groups
        .map((group) => ({
          label: group.label,
          items: group.items.filter((item) => matchesQuery(item, query)),
        }))
        .filter((group) => group.items.length > 0),
    [props.groups, query],
  );

  function setSelection(next: Set<string>): void {
    const catalog = new Set(catalogIds);
    const ordered = catalogIds.filter((id) => next.has(id));
    const extras = [...next].filter((id) => !catalog.has(id));
    props.onChange([...ordered, ...extras]);
  }

  function toggleItem(id: string, checked: boolean): void {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelection(next);
  }

  function toggleGroup(group: AgentScopeGroup, checked: boolean): void {
    const next = new Set(selectedIds);
    for (const item of group.items) {
      if (checked) next.add(item.id);
      else next.delete(item.id);
    }
    setSelection(next);
  }

  function addCustomEntry(): void {
    const name = customEntry.trim();
    if (!name) return;
    setCustomEntry('');
    setSelection(new Set([...selectedIds, name]));
  }

  const selectedCount = selectedIds.size;
  const totalCount = catalogIds.length;

  return (
    <section className={styles.scopeCard}>
      <header className={styles.scopeHeader}>
        <div>
          <h3 className={styles.scopeTitle}>{props.title}</h3>
          <p className="supporting-text">{props.description}</p>
        </div>
        <SegmentedToggle
          ariaLabel={`${props.title} scope`}
          size="sm"
          value={unrestricted ? 'all' : 'custom'}
          options={[
            { value: 'all', label: props.allLabel },
            { value: 'custom', label: 'Selected only' },
          ]}
          onChange={(mode) =>
            props.onChange(mode === 'all' ? null : [...catalogIds])
          }
        />
      </header>

      <div className={styles.scopeToolbar}>
        <Input
          aria-label={props.searchPlaceholder}
          placeholder={props.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className={styles.scopeCount}>
          {unrestricted
            ? `all ${totalCount} available`
            : `${selectedCount} of ${totalCount} selected`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={unrestricted}
          onClick={() => props.onChange(null)}
        >
          Reset to all
        </Button>
      </div>

      {props.loading ? (
        <div className="empty-state">Loading catalog...</div>
      ) : visibleGroups.length === 0 ? (
        <div className="empty-state">Nothing matches “{query}”.</div>
      ) : (
        <div className={styles.scopeGroups}>
          {visibleGroups.map((group) => {
            const checkedCount = group.items.filter((item) =>
              selectedIds.has(item.id),
            ).length;
            return (
              <div className={styles.scopeGroup} key={group.label}>
                <div className={styles.scopeGroupHead}>
                  <Checkbox
                    aria-label={`Select all ${group.label}`}
                    checked={
                      checkedCount === group.items.length
                        ? true
                        : checkedCount === 0
                          ? false
                          : 'indeterminate'
                    }
                    onCheckedChange={(checked) => toggleGroup(group, checked)}
                  />
                  <strong>{group.label}</strong>
                  <span className={styles.scopeCount}>
                    {checkedCount}/{group.items.length}
                  </span>
                </div>
                <div className={styles.scopeItems}>
                  {group.items.map((item) => (
                    <label className={styles.scopeItem} key={item.id}>
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        onCheckedChange={(checked) =>
                          toggleItem(item.id, checked)
                        }
                      />
                      <span className={styles.scopeItemText}>
                        <span className={styles.scopeItemName}>
                          {item.label}
                          {item.badges?.map((badge) => (
                            <em className={styles.scopeBadge} key={badge}>
                              {badge}
                            </em>
                          ))}
                        </span>
                        {item.description ? (
                          <small>{item.description}</small>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {props.allowCustomEntries ? (
        <div className={styles.scopeToolbar}>
          <Input
            aria-label={`Add ${props.title.toLowerCase()} by name`}
            placeholder="Add by exact name (for example github__create_issue)"
            value={customEntry}
            onChange={(event) => setCustomEntry(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addCustomEntry();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!customEntry.trim()}
            onClick={addCustomEntry}
          >
            Add
          </Button>
        </div>
      ) : null}

      <p className="supporting-text">
        {unrestricted
          ? `${props.allLabel} stay available.`
          : props.restrictedNote}
      </p>
    </section>
  );
}
