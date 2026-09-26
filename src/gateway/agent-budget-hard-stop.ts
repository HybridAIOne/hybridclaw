/**
 * Agent budget hard stop — the gate that refuses a turn once an agent has
 * spent 100% of its monthly `agents.list[].budget.cap`.
 *
 * Runs before the agent loop, so a refused turn costs nothing; a turn already
 * running when the cap is crossed is not interrupted. The spend math lives in
 * `board/budget-chip.ts` (shared with the chip and the 80% soft warn); this
 * module only applies the side effects of a refusal: pause the goal, audit it.
 */
import { recordAuditEvent } from '../audit/audit-events.js';
import { findAgentBudgetHardStop } from '../board/budget-chip.js';
import { pauseGoalForAgentBudgetHardStop } from '../goals/goal-runtime.js';
import type { Session } from '../types/session.js';

/** Returns the refusal message when the agent is over budget, else null. */
export function enforceAgentBudgetHardStop(params: {
  session: Session;
  runId: string;
  agentId: string;
  source: string;
}): string | null {
  const hardStop = findAgentBudgetHardStop(params.agentId);
  if (!hardStop) return null;
  pauseGoalForAgentBudgetHardStop(params.session);
  recordAuditEvent({
    sessionId: params.session.id,
    runId: params.runId,
    event: {
      type: 'budget.hard_stop',
      targetAgentId: hardStop.summary.agentId,
      source: params.source,
      billingWindow: hardStop.billingWindow,
      used: hardStop.summary.used,
      cap: hardStop.summary.cap,
      unit: hardStop.summary.unit,
    },
  });
  return hardStop.error;
}
