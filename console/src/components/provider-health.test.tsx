import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ProviderEntry, ProviderHealth } from './provider-health';

const ENTRIES: Array<[string, ProviderEntry]> = [
  [
    'hybridai',
    {
      kind: 'remote' as const,
      reachable: true,
      latencyMs: 12,
      modelCount: 3,
    },
  ],
  [
    'ollama',
    {
      kind: 'local' as const,
      reachable: false,
      modelCount: 0,
    },
  ],
];

describe('ProviderHealth', () => {
  it('renders detailed provider rows in the full variant', () => {
    render(<ProviderHealth title="Provider health" entries={ENTRIES} />);

    expect(screen.getByText('hybridai')).toBeTruthy();
    expect(screen.getByText('12ms')).toBeTruthy();
    expect(screen.getByText('ollama')).toBeTruthy();
    expect(screen.getByText('not running locally')).toBeTruthy();
  });

  it('summarizes health and invokes the compact manage action', () => {
    const onManage = vi.fn();
    render(
      <ProviderHealth
        title="Backend health"
        entries={ENTRIES}
        variant="compact"
        onManage={onManage}
      />,
    );

    expect(
      screen.getByText('Backend health').closest('section')?.textContent,
    ).toContain('1 healthy · 1 inactive');
    fireEvent.click(screen.getByRole('button', { name: 'Manage providers →' }));
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
