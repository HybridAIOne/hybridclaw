import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabbedPage, TabbedPageActions } from './tabbed-page';

describe('TabbedPage', () => {
  afterEach(cleanup);

  it('exposes the active panel and changes tabs', () => {
    const onTabChange = vi.fn();
    render(
      <TabbedPage
        tabs={[
          { id: 'first', label: 'First' },
          { id: 'second', label: 'Second' },
        ]}
        activeTab="first"
        onTabChange={onTabChange}
      >
        <p>Panel content</p>
      </TabbedPage>,
    );

    expect(
      screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toContain('Panel content');

    fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(onTabChange).toHaveBeenCalledWith('second');
  });

  it('renders contextual controls inside the tab bar', () => {
    render(
      <TabbedPage
        tabs={[{ id: 'queue', label: 'Work queue' }]}
        activeTab="queue"
        onTabChange={vi.fn()}
      >
        <TabbedPageActions>
          <input aria-label="Search jobs" />
        </TabbedPageActions>
        <p>Panel content</p>
      </TabbedPage>,
    );

    expect(
      screen
        .getByRole('textbox', { name: 'Search jobs' })
        .closest('.page-tabs'),
    ).not.toBeNull();
  });
});
