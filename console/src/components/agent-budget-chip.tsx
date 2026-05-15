import type { AdminBoardBudgetSummary } from '../api/types';

export type AgentBudgetChipTone = 'neutral' | 'warn' | 'hard';

export function agentBudgetChipTone(
  budget: Pick<AdminBoardBudgetSummary, 'percent'>,
): AgentBudgetChipTone {
  if (budget.percent >= 100) return 'hard';
  if (budget.percent >= 80) return 'warn';
  return 'neutral';
}

function formatCurrency(
  value: number,
  currency: AdminBoardBudgetSummary['currency'],
) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: value >= 10 ? 0 : 2,
  }).format(value);
}

export function AgentBudgetChip(props: {
  budget: AdminBoardBudgetSummary | null | undefined;
}) {
  if (!props.budget) return null;

  const tone = agentBudgetChipTone(props.budget);
  return (
    <span
      className="agent-budget-chip"
      data-tone={tone}
      title={`${Math.floor(props.budget.percent)}% used`}
    >
      {formatCurrency(props.budget.used, props.budget.currency)} /{' '}
      {formatCurrency(props.budget.cap, props.budget.currency)}
    </span>
  );
}
