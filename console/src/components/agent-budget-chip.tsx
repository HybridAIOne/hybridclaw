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

function formatTokenCount(value: number) {
  const abs = Math.abs(value);
  const compact =
    abs >= 1_000_000
      ? { divisor: 1_000_000, suffix: 'm' }
      : abs >= 1_000
        ? { divisor: 1_000, suffix: 'k' }
        : null;
  if (!compact) return Math.round(value).toLocaleString('en-US');

  const scaled = value / compact.divisor;
  const formatted = Number.isInteger(scaled)
    ? scaled.toFixed(0)
    : scaled.toFixed(1);
  return `${formatted}${compact.suffix}`;
}

function formatBudgetValue(budget: AdminBoardBudgetSummary, value: number) {
  return budget.unit === 'tokens'
    ? formatTokenCount(value)
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
