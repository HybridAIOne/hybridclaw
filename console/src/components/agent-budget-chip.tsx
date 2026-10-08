import type { AdminBoardBudgetSummary } from '../api/types';
import { formatCompactNumber } from '../lib/format';

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

function formatBudgetValue(budget: AdminBoardBudgetSummary, value: number) {
  return budget.unit === 'tokens'
    ? formatCompactNumber(value)
    : formatCurrency(value, budget.currency);
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
      {formatBudgetValue(props.budget, props.budget.used)} /{' '}
      {formatBudgetValue(props.budget, props.budget.cap)}
      {props.budget.unit === 'tokens' ? ' tokens' : ''}
    </span>
  );
}
