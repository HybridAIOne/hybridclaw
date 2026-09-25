import type {
  AgentBudgetConfig,
  AgentBudgetCurrency,
  AgentBudgetUnit,
} from '../agents/agent-types.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  hasBudgetSoftWarnMarker,
  type MonthlyUsageByAgentEntry,
  monthlyUsageByAgent,
  recordBudgetSoftWarnMarker,
  subscribeUsageRecords,
} from '../memory/db.js';
import { MODEL_METADATA_USD_TO_EUR } from '../providers/model-metadata.js';
import {
  emitRuntimeEvent,
  type RuntimeEventPayload,
} from '../skills/skill-run-events.js';
import { listActiveCardAgentOwnerIds } from './card-store.js';

export interface BoardBudgetSummary {
  agentId: string;
  used: number;
  cap: number;
  unit: AgentBudgetUnit;
  currency: AgentBudgetCurrency;
  percent: number;
}

export interface BoardBudgetSummaryResponse {
  budgets: BoardBudgetSummary[];
}

export interface BudgetSoftWarnEvent extends RuntimeEventPayload {
  type: 'budget.soft_warn';
  agent_id: string;
  billing_window: string;
  used: number;
  cap: number;
  unit: AgentBudgetUnit;
  currency: AgentBudgetCurrency;
  percent: number;
  created_at: string;
  source: 'board_budget_chip';
}

const SOFT_WARN_THRESHOLD = 80;

function billingWindowFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function normalizeAgentIds(agentIds: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(agentIds)
        .map((agentId) => agentId.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function activeBoardCardAgentIds(): string[] {
  return normalizeAgentIds(listActiveCardAgentOwnerIds());
}

function budgetConfigByAgent(): Map<string, AgentBudgetConfig> {
  const config = getRuntimeConfig();
  const budgets = new Map<string, AgentBudgetConfig>();
  for (const agent of config.agents.list || []) {
    if (!agent.budget) continue;
    budgets.set(agent.id, agent.budget);
  }
  return budgets;
}

function spendForCurrency(
  monthlySpendUsd: number,
  currency: AgentBudgetCurrency,
): number {
  return currency === 'EUR'
    ? monthlySpendUsd / MODEL_METADATA_USD_TO_EUR.usdPerEur
    : monthlySpendUsd;
}

function usageForBudget(
  monthlyUsage: MonthlyUsageByAgentEntry | undefined,
  unit: AgentBudgetUnit,
  currency: AgentBudgetCurrency,
): number {
  const usage = monthlyUsage ?? { totalCostUsd: 0, totalTokens: 0 };
  return unit === 'tokens'
    ? usage.totalTokens
    : spendForCurrency(usage.totalCostUsd, currency);
}

function buildBudgetSummary(
  agentId: string,
  budget: AgentBudgetConfig,
  monthlyUsage: MonthlyUsageByAgentEntry | undefined,
): BoardBudgetSummary {
  const unit = budget.unit;
  const used = usageForBudget(monthlyUsage, unit, budget.currency);
  const percent = budget.cap > 0 ? (used / budget.cap) * 100 : 0;
  return {
    agentId,
    used,
    cap: budget.cap,
    unit,
    currency: budget.currency,
    percent,
  };
}

export function maybeEmitBudgetSoftWarnForAgent(
  agentId: string,
  now = new Date(),
): void {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return;

  const budget = budgetConfigByAgent().get(normalizedAgentId);
  if (!budget || budget.cap <= 0) return;
  const billingWindow = billingWindowFor(now);
  if (hasBudgetSoftWarnMarker(normalizedAgentId, billingWindow, budget.unit)) {
    return;
  }

  const usageByAgent = monthlyUsageByAgent([normalizedAgentId], now);
  const summary = buildBudgetSummary(
    normalizedAgentId,
    budget,
    usageByAgent.get(normalizedAgentId),
  );
  if (summary.percent < SOFT_WARN_THRESHOLD) return;

  const emittedAt = now.toISOString();
  const recorded = recordBudgetSoftWarnMarker({
    agentId: summary.agentId,
    billingWindow,
    emittedAt,
    used: summary.used,
    cap: summary.cap,
    unit: summary.unit,
    currency: summary.currency,
    percent: summary.percent,
  });
  if (!recorded) return;

  const event: BudgetSoftWarnEvent = {
    type: 'budget.soft_warn',
    agent_id: summary.agentId,
    billing_window: billingWindow,
    used: summary.used,
    cap: summary.cap,
    unit: summary.unit,
    currency: summary.currency,
    percent: summary.percent,
    created_at: emittedAt,
    source: 'board_budget_chip',
  };
  emitRuntimeEvent(event);
}

export interface AgentBudgetHardStop {
  summary: BoardBudgetSummary;
  billingWindow: string;
  error: string;
}

function formatBudgetAmount(value: number, unit: AgentBudgetUnit): string {
  return unit === 'tokens'
    ? `${Math.round(value)} tokens`
    : `${value.toFixed(2)} ${unit}`;
}

// A cap is a hard limit: at 100% the agent takes no new turns until the next
// UTC billing month or until an operator raises the cap. Enforced by
// `gateway/agent-budget-hard-stop.ts`.
export function findAgentBudgetHardStop(
  agentId: string,
  now = new Date(),
): AgentBudgetHardStop | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  const budget = budgetConfigByAgent().get(normalizedAgentId);
  if (!budget || budget.cap <= 0) return null;
  const summary = buildBudgetSummary(
    normalizedAgentId,
    budget,
    monthlyUsageByAgent([normalizedAgentId], now).get(normalizedAgentId),
  );
  if (summary.used < summary.cap) return null;
  const billingWindow = billingWindowFor(now);
  return {
    summary,
    billingWindow,
    error: `Monthly budget exhausted for agent "${normalizedAgentId}": ${formatBudgetAmount(summary.used, summary.unit)} used of ${formatBudgetAmount(summary.cap, summary.unit)} in ${billingWindow}. Raise the agent's budget cap or wait for the next billing month.`,
  };
}

subscribeUsageRecords((agentIds) => {
  for (const agentId of agentIds) {
    maybeEmitBudgetSoftWarnForAgent(agentId);
  }
});

export function getBoardBudgetSummaries(options?: {
  agentIds?: string[];
}): BoardBudgetSummaryResponse {
  const agentIds = normalizeAgentIds(
    options?.agentIds?.length ? options.agentIds : activeBoardCardAgentIds(),
  );
  const configuredBudgets = budgetConfigByAgent();
  const budgetedAgentEntries = agentIds
    .map((agentId) => [agentId, configuredBudgets.get(agentId)] as const)
    .filter((entry): entry is readonly [string, AgentBudgetConfig] =>
      Boolean(entry[1] && entry[1].cap > 0),
    );
  const usageByAgent = monthlyUsageByAgent(
    budgetedAgentEntries.map(([agentId]) => agentId),
  );
  const budgets: BoardBudgetSummary[] = [];

  for (const [agentId, budget] of budgetedAgentEntries) {
    budgets.push(
      buildBudgetSummary(agentId, budget, usageByAgent.get(agentId)),
    );
  }

  return { budgets };
}
