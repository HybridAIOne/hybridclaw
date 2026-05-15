import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/toast';
import { BoardPage } from './board';

const fetchBoardBudgetSummariesMock = vi.fn();
const fetchBoardCardsMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchBoardBudgetSummaries: (...args: unknown[]) =>
    fetchBoardBudgetSummariesMock(...args),
  fetchBoardCards: (...args: unknown[]) => fetchBoardCardsMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function renderBoardPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BoardPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('BoardPage', () => {
  beforeEach(() => {
    fetchBoardBudgetSummariesMock.mockReset();
    fetchBoardCardsMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchBoardCardsMock.mockResolvedValue({ cards: [] });
    fetchBoardBudgetSummariesMock.mockResolvedValue({ budgets: [] });
  });

  it('renders R29.8 board cards with budget chips for agent owners', async () => {
    fetchBoardCardsMock.mockResolvedValue({
      cards: [
        {
          id: 'card-main',
          title: 'Review launch brief',
          body: 'Approve the launch checklist.',
          owner: { agentId: 'main' },
          column: 'in_review',
          status: 'open',
          source: 'manual',
          parent: null,
          createdAt: '2026-05-14T12:00:00.000Z',
          updatedAt: '2026-05-14T12:00:00.000Z',
          deletedAt: null,
        },
        {
          id: 'card-user',
          title: 'Operator note',
          body: 'Human-owned card.',
          owner: { userId: 'operator' },
          column: 'triage',
          status: 'open',
          source: 'manual',
          parent: null,
          createdAt: '2026-05-14T12:00:00.000Z',
          updatedAt: '2026-05-14T12:00:00.000Z',
          deletedAt: null,
        },
      ],
    });
    fetchBoardBudgetSummariesMock.mockResolvedValue({
      budgets: [
        {
          agentId: 'main',
          used: 81,
          cap: 100,
          currency: 'USD',
          percent: 81,
        },
      ],
    });

    renderBoardPage();

    expect(await screen.findByText('Review launch brief')).toBeTruthy();
    expect(screen.getByText('Operator note')).toBeTruthy();

    await waitFor(() => {
      expect(fetchBoardBudgetSummariesMock).toHaveBeenCalledWith('test-token', [
        'main',
      ]);
    });
    expect(screen.getByText('$81 / $100').getAttribute('data-tone')).toBe(
      'warn',
    );
    expect(screen.queryByText('$0 / $0')).toBeNull();
  });
});
