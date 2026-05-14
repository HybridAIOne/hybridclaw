import { resolveAgentConfig } from '../agents/agent-registry.js';
import type { AgentBudgetConfig } from '../agents/agent-types.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  getMemoryValue,
  monthlySpendEur,
  monthlySpendUsd,
  setMemoryValue,
} from '../memory/db.js';
import {
  emitRuntimeEvent,
  type RuntimeEventPayload,
} from '../skills/skill-run-events.js';
import { listCards } from './card-store.js';

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
const SOFT_WARN_MARKER_PREFIX = 'budget.soft_warn';

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
  const agentIds: string[] = [];
  for (const card of listCards()) {
    if ('agentId' in card.owner && card.owner.agentId) {
      agentIds.push(card.owner.agentId);
    }
  }
  return normalizeAgentIds(agentIds);
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

function maybeEmitSoftWarnEvent(summary: BoardBudgetSummary, now: Date): void {
  if (summary.percent < SOFT_WARN_THRESHOLD) return;

  const billingWindow = billingWindowFor(now);
  const markerKey = `${SOFT_WARN_MARKER_PREFIX}.${billingWindow}`;
  if (getMemoryValue(summary.agentId, markerKey)) return;

  const event: BudgetSoftWarnEvent = {
    type: 'budget.soft_warn',
    agent_id: summary.agentId,
    billing_window: billingWindow,
    used: summary.used,
    cap: summary.cap,
    currency: summary.currency,
    percent: summary.percent,
    created_at: now.toISOString(),
    source: 'board_budget_chip',
  };
  emitRuntimeEvent(event);
  setMemoryValue(summary.agentId, markerKey, {
    emittedAt: event.created_at,
    percent: summary.percent,
  });
}

export function getBoardBudgetSummaries(options?: {
  agentIds?: string[];
  now?: Date;
}): BoardBudgetSummaryResponse {
  const agentIds = normalizeAgentIds(
    options?.agentIds?.length ? options.agentIds : activeBoardCardAgentIds(),
  );
  const configuredBudgets = budgetConfigByAgent();
  const now = options?.now ?? new Date();
  const budgets: BoardBudgetSummary[] = [];

  for (const agentId of agentIds) {
    const budget = resolveBudgetConfig(agentId, configuredBudgets);
    if (!budget || budget.cap <= 0) continue;

    const currency = budget.currency;
    const used = spendFor(agentId, currency);
    const percent = budget.cap > 0 ? (used / budget.cap) * 100 : 0;
    const summary = {
      agentId,
      used,
      cap: budget.cap,
      currency,
      percent,
    } satisfies BoardBudgetSummary;
    maybeEmitSoftWarnEvent(summary, now);
    budgets.push(summary);
  }

  return { budgets };
}
