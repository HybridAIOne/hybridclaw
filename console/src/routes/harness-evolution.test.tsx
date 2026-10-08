import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminHarnessEvolutionResponse,
  AdminHarnessEvolutionRunResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { HarnessEvolutionPage } from './harness-evolution';

const fetchRunsMock = vi.hoisted(() => vi.fn());
const fetchRunMock = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  fetchHarnessEvolutionRuns: fetchRunsMock,
  fetchHarnessEvolutionRun: fetchRunMock,
  fetchHarnessEvolutionManifest: vi.fn(),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

function mockRun(totalCostUsd: number, budgetUsd: number | null): void {
  fetchRunsMock.mockResolvedValue({
    targetRoot: '/srv/coworker',
    runs: [
      {
        runId: 'run-a',
        suiteName: 'Suite A',
        roundCount: 0,
        bestPassAt1: 0.5,
        summaryPath: '/srv/coworker/runs/run-a/summary.json',
      },
    ],
  } as unknown as AdminHarnessEvolutionResponse);
  fetchRunMock.mockResolvedValue({
    run: {
      runId: 'run-a',
      bestPassAt1: 0.5,
      bestRound: null,
      rounds: [],
      costGate: {
        totalCostUsd,
        budgetUsd,
        ok: budgetUsd == null || totalCostUsd <= budgetUsd,
      },
      seedDelta: { mode: 'fresh', changedSurfaceCount: 0 },
    },
  } as unknown as AdminHarnessEvolutionRunResponse);
}

async function costCard(): Promise<HTMLElement> {
  renderWithProviders(<HarnessEvolutionPage />);
  fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
    target: { value: '/srv/coworker' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  await vi.waitFor(() => expect(fetchRunMock).toHaveBeenCalled());
  const label = await screen.findByText('Cost');
  return label.closest('.metric-card') as HTMLElement;
}

describe('HarnessEvolutionPage cost', () => {
  afterEach(() => {
    fetchRunsMock.mockReset();
    fetchRunMock.mockReset();
  });

  it.each([
    [0.0123, null, '$0.0123', 'no budget'],
    [12.5, 20, '$12.5000', 'within budget'],
    [25, 20, '$25.0000', 'over budget'],
  ])(
    'shows %d USD against budget %s as %s (%s)',
    async (cost, budget, value, detail) => {
      mockRun(cost, budget);
      const card = await costCard();
      await vi.waitFor(() =>
        expect(within(card).getByText(value)).toBeTruthy(),
      );
      expect(within(card).getByText(detail)).toBeTruthy();
    },
  );
});
