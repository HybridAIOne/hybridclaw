import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabbedPage } from './tabbed-page';

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
});
