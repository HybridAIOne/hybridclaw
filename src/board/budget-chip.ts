import { resolveAgentConfig } from '../agents/agent-registry.js';
import type { AgentBudgetConfig } from '../agents/agent-types.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  monthlySpendEur,
  monthlySpendUsd,
  recordBudgetSoftWarnMarker,
  subscribeUsageRecords,
} from '../memory/db.js';
import {
  emitRuntimeEvent,
  type RuntimeEventPayload,
} from '../skills/skill-run-events.js';
import { listActiveCardAgentOwnerIds } from './card-store.js';

export type BoardBudgetCurrency = 'USD' | 'EUR';

export interface BoardBudgetSummary {
  agentId: string;
  used: number;
  cap: number;
  currency: BoardBudgetCurrency;
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
  currency: BoardBudgetCurrency;
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

function resolveBudgetConfig(
  agentId: string,
  configuredBudgets: Map<string, AgentBudgetConfig>,
): AgentBudgetConfig | undefined {
  return configuredBudgets.get(agentId) ?? resolveAgentConfig(agentId).budget;
}

function spendFor(agentId: string, currency: BoardBudgetCurrency): number {
  return currency === 'EUR'
    ? monthlySpendEur(agentId)
    : monthlySpendUsd(agentId);
}

function buildBudgetSummary(
  agentId: string,
  budget: AgentBudgetConfig,
): BoardBudgetSummary {
  const currency = budget.currency;
  const used = spendFor(agentId, currency);
  const percent = budget.cap > 0 ? (used / budget.cap) * 100 : 0;
  return {
    agentId,
    used,
    cap: budget.cap,
    currency,
    percent,
  };
}

export function maybeEmitBudgetSoftWarnForAgent(
  agentId: string,
  now = new Date(),
): void {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return;

  const budget = resolveBudgetConfig(normalizedAgentId, budgetConfigByAgent());
  if (!budget || budget.cap <= 0) return;
  const summary = buildBudgetSummary(normalizedAgentId, budget);
  if (summary.percent < SOFT_WARN_THRESHOLD) return;

  const emittedAt = now.toISOString();
  const billingWindow = billingWindowFor(now);
  const recorded = recordBudgetSoftWarnMarker({
    agentId: summary.agentId,
    billingWindow,
    emittedAt,
    used: summary.used,
    cap: summary.cap,
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
  const budgets: BoardBudgetSummary[] = [];

  for (const agentId of agentIds) {
    const budget = resolveBudgetConfig(agentId, configuredBudgets);
    if (!budget || budget.cap <= 0) continue;
    budgets.push(buildBudgetSummary(agentId, budget));
  }

  return { budgets };
}
