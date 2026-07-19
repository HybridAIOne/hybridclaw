import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommandPalette } from './command-palette';

describe('CommandPalette', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/admin');
  });

  it('opens with the global shortcut and finds page-owned settings', () => {
    render(<CommandPalette />);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const search = screen.getByRole('combobox', {
      name: 'Search pages and settings',
    });
    fireEvent.change(search, { target: { value: 'log level' } });

    expect(screen.getByRole('option', { name: /log level/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /log level/i }));
    expect(window.location.pathname).toBe('/admin/logs');
  });

  it('deep-links generated settings to their section and field anchor', () => {
    render(<CommandPalette />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Search pages and settings' }),
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Search pages and settings' }),
      { target: { value: 'memory pressure rss' } },
    );
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Search pages and settings' }),
      { key: 'Enter' },
    );

    expect(window.location.pathname).toBe('/admin/config');
    expect(new URLSearchParams(window.location.search).get('section')).toBe(
      'container',
    );
    expect(window.location.hash).toBe(
      '#setting-container-warmPool-memoryPressureRssMb',
    );
  });
});
