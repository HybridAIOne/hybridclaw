/**
 * `POST /api/cost-estimate`: the container's `estimate_cost` tool, on the
 * calling session. The agent calls it before a big task; the reply then shows
 * the estimate as a card (`costEstimate` on the turn result) and the agent asks
 * whether to go ahead.
 *
 * The figures are the runtime's, from the session's model and context size,
 * never from the agent's own guess at a price.
 */
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { getSessionById } from '../memory/db.js';
import { refreshModelCatalogMetadata } from '../providers/model-catalog.js';
import {
  estimateTaskCost,
  rememberTaskCostEstimate,
  type TaskCostEstimate,
} from '../usage/task-cost.js';
import { isRecord } from '../utils/type-guards.js';
import { readSessionStatusSnapshot } from './gateway-session-status.js';

const MAX_STEPS = 500;

const euros = (value: number) => `€${value.toFixed(2)}`;

export function costEstimateText(estimate: TaskCostEstimate): string {
  const figures = estimate.free
    ? `about ${estimate.requests} model requests on a free model, so no charge; they count against the user's request allowance`
    : `${euros(estimate.low)}–${euros(estimate.high)}, about ${estimate.requests} model requests`;
  return `Estimate: ${figures}. The user sees it as a card under your reply. Say in one short sentence what you are about to do and ask whether to go ahead, without repeating the figures. Do not start the task in this reply; wait for their answer.`;
}

export async function runCostEstimateToolAction(body: unknown): Promise<{
  ok: true;
  result: string;
}> {
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  }
  const steps = Number(body.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
    throw new GatewayRequestError(
      400,
      `Give \`steps\`, a whole number from 1 to ${MAX_STEPS}.`,
    );
  }
  const session = getSessionById(
    typeof body.sessionId === 'string' ? body.sessionId : '',
  );
  if (!session) throw new GatewayRequestError(404, 'Unknown session.');
  const { model } = resolveAgentForRequest({ session });
  await refreshModelCatalogMetadata(model);
  const estimate = estimateTaskCost({
    model,
    steps,
    contextTokens: readSessionStatusSnapshot(session.id, {
      currentModel: model,
    }).contextUsedTokens,
  });
  if (!estimate) {
    return {
      ok: true,
      result: `No estimate: the price of ${model} is unknown. Tell the user the task is long, about ${steps} steps, and ask whether to go ahead before you start.`,
    };
  }
  rememberTaskCostEstimate(session.id, estimate);
  return { ok: true, result: costEstimateText(estimate) };
}
