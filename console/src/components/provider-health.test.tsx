import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('keeps the complete provider diagnostic available for long status rows', () => {
    const diagnostic =
      'Mistral is disabled. Enable it: config set mistral.enabled true';
    render(
      <ProviderHealth
        title="Provider health"
        entries={[
          [
            'mistral',
            {
              kind: 'remote',
              reachable: false,
              error: diagnostic,
            },
          ],
        ]}
      />,
    );

    expect(screen.getByText(diagnostic).getAttribute('title')).toBe(diagnostic);
  });
});
