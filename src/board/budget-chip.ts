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
