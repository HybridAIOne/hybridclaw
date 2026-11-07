/**
 * A scheduled run's approval, answered in the chat that shows it.
 *
 * The answer resumes the run in its own session (`scheduled-approval.ts`),
 * with the run's own tools and limits, and the reply is delivered like any
 * scheduled reply. The claim goes through the pending registry like any
 * answer, first responder wins. NOT a chat turn in the run's session; every
 * other answer passes through to the chat turn unchanged.
 */
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { getJob } from '../memory/jobs.js';
import { memoryService } from '../memory/memory-service.js';
import { runIsolatedScheduledTask } from '../scheduler/scheduled-task-runner.js';
import {
  approvalAnswerText,
  type GatewayApprovalAnswer,
} from './approval-answer.js';
import { claimApprovalResponse } from './approval-coordination.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import { handoffPendingApprovalClaim } from './pending-approvals.js';
import {
  type ScheduledApproval,
  scheduledApproval,
} from './scheduled-approval.js';
import { deliverWebScheduledMessage } from './web-scheduled-delivery.js';

export function withScheduledApprovalAnswers(
  handle: (request: GatewayChatRequest) => Promise<GatewayChatResult>,
): (request: GatewayChatRequest) => Promise<GatewayChatResult> {
  return async (request) => {
    const answer = request.approval;
    const run =
      answer && request.channelId === 'web'
        ? scheduledApproval(request.sessionId, answer.approvalId)
        : null;
    return answer && run
      ? resumeScheduledRun(request, answer, run)
      : handle(request);
  };
}

async function resumeScheduledRun(
  request: GatewayChatRequest,
  answer: GatewayApprovalAnswer,
  { work, source }: ScheduledApproval,
): Promise<GatewayChatResult> {
  const claim = claimApprovalResponse(
    work.runSessionId,
    answer.approvalId,
    request.userId,
    request.approvalClaim,
  );
  if (!handoffPendingApprovalClaim(claim))
    throw new GatewayRequestError(409, 'This approval is no longer pending.');
  // The run resolves its agent and model as it did when the task fired.
  const origin = memoryService.getSessionById(
    work.originSessionId ?? request.sessionId,
  );
  const task = getJob(work.taskId, { kind: 'scheduled_task' });
  const { agentId, chatbotId, model } = resolveAgentForRequest({
    session: origin,
    agentId: work.agentId,
  });
  let reply: GatewayChatResult = {
    status: 'error',
    result: null,
    toolsUsed: [],
    sessionId: request.sessionId,
    error: 'The scheduled task stopped before it answered.',
  };
  await runIsolatedScheduledTask({
    taskId: work.taskId,
    originSessionId: origin?.id,
    prompt: approvalAnswerText(answer),
    approver: request.userId,
    channelId: 'web',
    chatbotId,
    model: task?.model || model,
    reasoningEffort: task?.effort ?? undefined,
    agentId,
    sessionId: work.runSessionId,
    sessionKey: work.runSessionId,
    mainSessionKey: origin?.main_session_key,
    onResult: (result) => {
      const { messageId } = deliverWebScheduledMessage(
        request.sessionId,
        result.text,
        source,
        result.artifacts,
        result.storedMessage,
        result.workId,
      );
      const { approval, emailDraft } = result.storedMessage ?? {};
      reply = {
        status: 'success',
        result: result.text,
        toolsUsed: [],
        sessionId: request.sessionId,
        assistantMessageId: messageId,
        ...(result.artifacts?.length ? { artifacts: result.artifacts } : {}),
        ...(approval ? { pendingApproval: approval } : {}),
        ...(emailDraft ? { emailDraft } : {}),
      };
    },
    onError: (error) => {
      reply.error = error instanceof Error ? error.message : String(error);
    },
  });
  return reply;
}
