import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchBoardBudgetSummaries, fetchBoardCards } from '../api/client';
import type {
  AdminBoardBudgetSummary,
  AdminBoardCard,
  AdminBoardCardColumn,
} from '../api/types';
import { useAuth } from '../auth';
import { AgentBudgetChip } from '../components/agent-budget-chip';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

const BOARD_COLUMNS: ReadonlyArray<{
  id: AdminBoardCardColumn;
  title: string;
}> = [
  { id: 'triage', title: 'Triage' },
  { id: 'todo', title: 'To Do' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'in_review', title: 'In Review' },
  { id: 'done', title: 'Done' },
];

function trimText(value: string | null | undefined, maxLength: number): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function boardCardOwnerLabel(card: AdminBoardCard): string {
  if ('agentId' in card.owner && card.owner.agentId) return card.owner.agentId;
  return card.owner.userId ?? 'Unassigned';
}

function boardCardOwnerAgentId(card: AdminBoardCard): string | null {
  return 'agentId' in card.owner ? (card.owner.agentId ?? null) : null;
}

function BoardCard(props: {
  card: AdminBoardCard;
  budget: AdminBoardBudgetSummary | null;
}) {
  return (
    <article className="board-card">
      <div className="board-card-top">
        <strong>{trimText(props.card.title, 42)}</strong>
        <AgentBudgetChip budget={props.budget} />
      </div>
      <p>{trimText(props.card.body, 140) || props.card.status}</p>
      <div className="board-card-meta">
        <span>{boardCardOwnerLabel(props.card)}</span>
        <span>{props.card.source}</span>
      </div>
    </article>
  );
}

export function BoardPage() {
  const auth = useAuth();

  const cardsQuery = useQuery({
    queryKey: ['board-cards', auth.token],
    queryFn: () => fetchBoardCards(auth.token),
    refetchInterval: 30_000,
  });

  const ownerAgentIds = useMemo(
    () =>
      Array.from(
        new Set(
          (cardsQuery.data?.cards || [])
            .map(boardCardOwnerAgentId)
            .filter((agentId): agentId is string => Boolean(agentId)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [cardsQuery.data?.cards],
  );

  const budgetQuery = useQuery({
    queryKey: ['board-budget-summaries', auth.token, ownerAgentIds.join('\0')],
    queryFn: () => fetchBoardBudgetSummaries(auth.token, ownerAgentIds),
    enabled: ownerAgentIds.length > 0,
    staleTime: 30_000,
  });

  const budgetsByAgent = useMemo(
    () =>
      new Map(
        (budgetQuery.data?.budgets || []).map(
          (budget) => [budget.agentId, budget] as const,
        ),
      ),
    [budgetQuery.data?.budgets],
  );

  const cardsByColumn = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => ({
        ...column,
        cards: (cardsQuery.data?.cards || []).filter(
          (card) => card.column === column.id,
        ),
      })),
    [cardsQuery.data?.cards],
  );

  if (cardsQuery.isLoading && !cardsQuery.data) {
    return <div className="empty-state">Loading board...</div>;
  }

  if (cardsQuery.isError && !cardsQuery.data) {
    return (
      <div className="empty-state error">
        {getErrorMessage(cardsQuery.error)}
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader title="Board" />

      {budgetQuery.isError ? (
        <p className="error-banner">{getErrorMessage(budgetQuery.error)}</p>
      ) : null}

      <section className="board-columns">
        {cardsByColumn.map((column) => (
          <section className="board-column" key={column.id}>
            <div className="board-column-header">
              <strong>{column.title}</strong>
              <span>{column.cards.length}</span>
            </div>
            <div className="board-column-body">
              {column.cards.length ? (
                column.cards.map((card) => {
                  const ownerAgentId = boardCardOwnerAgentId(card);
                  return (
                    <BoardCard
                      budget={
                        ownerAgentId
                          ? budgetsByAgent.get(ownerAgentId) || null
                          : null
                      }
                      card={card}
                      key={card.id}
                    />
                  );
                })
              ) : (
                <div className="board-column-empty">No cards</div>
              )}
            </div>
          </section>
        ))}
      </section>
    </div>
  );
}
