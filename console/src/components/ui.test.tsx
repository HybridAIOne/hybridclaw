import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SortableHeader, useSortableRows } from './ui';

type TestRow = {
  name: string;
  count: number;
};

type TestSortKey = 'name' | 'count';

const TEST_ROWS: TestRow[] = [
  { name: 'alpha', count: 1 },
  { name: 'bravo', count: 3 },
  { name: 'charlie', count: 2 },
];

const TEST_SORTERS: Record<
  TestSortKey,
  (left: TestRow, right: TestRow) => number
> = {
  name: (left, right) => left.name.localeCompare(right.name),
  count: (left, right) => left.count - right.count,
};

function SortableTestTable() {
  const { sortedRows, sortState, toggleSort } = useSortableRows<
    TestRow,
    TestSortKey
  >(TEST_ROWS, {
    initialSort: {
      key: 'count',
      direction: 'desc',
    },
    sorters: TEST_SORTERS,
    defaultDirections: {
      count: 'desc',
    },
  });

  return (
    <table>
      <thead>
        <tr>
          <SortableHeader
            label="Name"
            sortKey="name"
            sortState={sortState}
            onToggle={toggleSort}
          />
          <SortableHeader
            label="Count"
            sortKey="count"
            sortState={sortState}
            onToggle={toggleSort}
          />
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => (
          <tr key={row.name}>
            <td>{row.name}</td>
            <td>{row.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function readFirstColumnValues(): string[] {
  const [, body] = screen.getAllByRole('rowgroup');
  const rows = within(body).getAllByRole('row');
  return rows.map((row) => {
    const [cell] = within(row).getAllByRole('cell');
    return cell.textContent || '';
  });
}

describe('admin table sorting', () => {
  it('applies the default sort and toggles when headers are clicked', () => {
    render(<SortableTestTable />);

    expect(
      screen
        .getByRole('columnheader', { name: 'Count' })
        .getAttribute('aria-sort'),
    ).toBe('descending');
    expect(readFirstColumnValues()).toEqual(['bravo', 'charlie', 'alpha']);

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(
      screen
        .getByRole('columnheader', { name: 'Name' })
        .getAttribute('aria-sort'),
    ).toBe('ascending');
    expect(readFirstColumnValues()).toEqual(['alpha', 'bravo', 'charlie']);

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(
      screen
        .getByRole('columnheader', { name: 'Name' })
        .getAttribute('aria-sort'),
    ).toBe('descending');
    expect(readFirstColumnValues()).toEqual(['charlie', 'bravo', 'alpha']);
  });
});
