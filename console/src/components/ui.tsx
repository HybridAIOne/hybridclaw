import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

export { ToggleGroup, ToggleGroupItem };

export type TableSortDirection = 'asc' | 'desc';

export interface TableSortState<Key extends string> {
  key: Key;
  direction: TableSortDirection;
}

export function useSortableRows<Row, Key extends string>(
  rows: readonly Row[],
  options: {
    initialSort: TableSortState<Key>;
    sorters: Record<Key, (left: Row, right: Row) => number>;
    defaultDirections?: Partial<Record<Key, TableSortDirection>>;
  },
): {
  sortedRows: Row[];
  sortState: TableSortState<Key>;
  toggleSort: (key: Key) => void;
} {
  const [sortState, setSortState] = useState<TableSortState<Key>>(
    options.initialSort,
  );

  const sortedRows = useMemo(() => {
    const compare = options.sorters[sortState.key];
    if (!compare) {
      return [...rows];
    }
    return [...rows].sort((left, right) => {
      const result = compare(left, right);
      if (result === 0) return 0;
      return sortState.direction === 'asc' ? result : -result;
    });
  }, [options.sorters, rows, sortState]);

  const toggleSort = (key: Key) => {
    setSortState((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return {
        key,
        direction: options.defaultDirections?.[key] || 'asc',
      };
    });
  };

  return { sortedRows, sortState, toggleSort };
}

export function SortableHeader<Key extends string>(props: {
  label: string;
  sortKey: Key;
  sortState: TableSortState<Key>;
  onToggle: (key: Key) => void;
}) {
  const active = props.sortState.key === props.sortKey;
  const ariaSort = active
    ? props.sortState.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';

  return (
    <th aria-sort={ariaSort}>
      <button
        type="button"
        className="table-sort-button"
        onClick={() => props.onToggle(props.sortKey)}
      >
        <span>{props.label}</span>
        <span
          aria-hidden="true"
          className={
            active
              ? `table-sort-indicator is-active is-${props.sortState.direction}`
              : 'table-sort-indicator'
          }
        />
      </button>
    </th>
  );
}

export function PageHeader(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  if (!props.description && !props.actions) {
    return null;
  }

  return (
    <div className="page-header">
      {props.description ? (
        <p className="supporting-text page-header-description">
          {props.description}
        </p>
      ) : (
        <span />
      )}
      {props.actions ? (
        <div className="header-actions">{props.actions}</div>
      ) : null}
    </div>
  );
}

export function Panel(props: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  accent?: 'default' | 'warm';
  id?: string;
}) {
  return (
    <section
      id={props.id}
      className={props.accent === 'warm' ? 'panel warm' : 'panel'}
    >
      {props.title ? (
        <div className="panel-header">
          <div>
            <h4>{props.title}</h4>
            {props.subtitle ? (
              <p className="supporting-text">{props.subtitle}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export function MetricCard(props: {
  label: string;
  value: string;
  detail?: string;
  href?: string;
}) {
  const content = (
    <>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail ? <small>{props.detail}</small> : null}
    </>
  );

  if (props.href) {
    return (
      <a className="metric-card metric-card-link" href={props.href}>
        {content}
      </a>
    );
  }

  return <div className="metric-card">{content}</div>;
}

export function SegmentedToggle(props: {
  ariaLabel: string;
  value: string;
  className?: string;
  options: Array<{
    value: string;
    label: string;
    activeTone?: 'is-on' | 'is-off';
  }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
}) {
  return (
    <ToggleGroup
      value={props.value}
      onValueChange={props.onChange}
      ariaLabel={props.ariaLabel}
      className={props.className}
      disabled={props.disabled}
      size={props.size}
    >
      {props.options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          activeTone={opt.activeTone}
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function BooleanPill(props: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  falseTone?: 'default' | 'danger';
}) {
  const label = props.value
    ? (props.trueLabel ?? 'on')
    : (props.falseLabel ?? 'off');
  const falseToneClass =
    !props.value && props.falseTone === 'danger' ? ' tone-danger' : '';

  return (
    <span
      className={
        props.value
          ? 'boolean-pill is-on'
          : `boolean-pill is-off${falseToneClass}`
      }
    >
      <span className="boolean-pill-dot" />
      {label}
    </span>
  );
}

export function BooleanToggle(props: {
  value: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
  size?: 'sm' | 'default';
}) {
  return (
    <SegmentedToggle
      className="boolean-toggle"
      ariaLabel={props.ariaLabel}
      value={props.value ? 'true' : 'false'}
      size={props.size}
      options={[
        {
          value: 'true',
          label: props.trueLabel ?? 'on',
          activeTone: 'is-on',
        },
        {
          value: 'false',
          label: props.falseLabel ?? 'off',
          activeTone: 'is-off',
        },
      ]}
      disabled={props.disabled}
      onChange={(value) => {
        props.onChange(value === 'true');
      }}
    />
  );
}

export function BooleanField(props: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field boolean-field">
      <span>{props.label}</span>
      <BooleanToggle
        value={props.value}
        onChange={props.onChange}
        trueLabel={props.trueLabel}
        falseLabel={props.falseLabel}
        disabled={props.disabled}
        ariaLabel={props.label}
      />
    </div>
  );
}
