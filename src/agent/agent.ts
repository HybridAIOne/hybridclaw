import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { HYBRIDAI_MODEL } from '../config/config.js';
import { logger } from '../logger.js';
import { injectPdfContextMessages } from '../media/pdf-context.js';
import { withSpan } from '../observability/otel.js';
import {
  createConfidentialRuntimeContext,
  getConfidentialRuleSet,
  isConfidentialRedactionEnabled,
} from '../security/confidential-runtime.js';
import { withResolvedSecretLeakRules } from '../security/secret-leak-corpus.js';
import type { ContainerOutput } from '../types/container.js';
import type {
  PendingApproval,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import { createConfidentialLeakMiddlewareSkill } from './confidential-middleware.js';
import { getExecutor } from './executor.js';
import type { ExecutorRequest } from './executor-types.js';
import {
  applyClassifierMiddleware,
  getLatestUserTextContent,
  type MiddlewareEvent,
} from './middleware.js';
import { mergeBlockedToolNames } from './tool-policy.js';

const TOOL_EXECUTION_REHYDRATE_FIELDS: ReadonlyArray<keyof ToolExecution> = [
  'arguments',
  'result',
  'blockedReason',
  'approvalIntent',
  'approvalReason',
];

const PENDING_APPROVAL_REHYDRATE_FIELDS: ReadonlyArray<keyof PendingApproval> =
  ['prompt', 'intent', 'reason'];

const TOOL_PROGRESS_REHYDRATE_FIELDS: ReadonlyArray<keyof ToolProgressEvent> = [
  'preview',
];

function firstEscalationEvent(
  events: readonly MiddlewareEvent[],
): MiddlewareEvent | null {
  return events.find((event) => event.action === 'escalate') || null;
}

function escalationEvents(
  events: readonly MiddlewareEvent[],
): MiddlewareEvent[] {
  return events.filter((event) => event.action === 'escalate');
}

function safeMiddlewareLabel(value: string): string {
  const normalized = value.replace(/[^\w:.-]/g, '_').slice(0, 120);
  return normalized || 'unknown';
}

function buildMiddlewarePendingApproval(params: {
  event: MiddlewareEvent;
  escalationTarget: PendingApproval['escalationTarget'];
}): PendingApproval {
  const approvalId = `mw-${randomUUID().slice(0, 8)}`;
  const reason =
    params.event.reason || 'Middleware requested operator escalation.';
  const middlewareId = safeMiddlewareLabel(params.event.skillId);
  return {
    approvalId,
    prompt: [
      'Middleware escalation requires operator review before this response is delivered.',
      `Middleware: ${middlewareId}`,
      `Route: ${params.event.route || 'approval_request'}`,
      `Why: ${reason}`,
      `Approval ID: ${approvalId}`,
      'Reply `yes` to approve once, or `no` to deny.',
    ].join('\n'),
    intent: `Review middleware escalation for ${middlewareId}`,
    reason,
    allowSession: false,
    allowAgent: false,
    allowAll: false,
    expiresAt: null,
    ...(params.escalationTarget
      ? { escalationTarget: params.escalationTarget }
      : {}),
  };
}

function buildMiddlewareToolExecution(params: {
  event: MiddlewareEvent;
  pendingApproval: PendingApproval;
  escalationTarget: PendingApproval['escalationTarget'];
}): ToolExecution {
  return {
    name: `middleware:${safeMiddlewareLabel(params.event.skillId)}`,
    arguments: '{}',
    result: params.pendingApproval.prompt,
    durationMs: 0,
    isError: false,
    blocked: true,
    blockedReason: params.event.reason,
    approvalTier: 'red',
    approvalBaseTier: 'red',
    autonomyLevel: 'confirm-each',
    stakes: 'high',
    escalationRoute: 'approval_request',
    ...(params.escalationTarget
      ? { escalationTarget: params.escalationTarget }
      : {}),
    approvalDecision: 'required',
    approvalActionKey: `middleware:${params.event.skillId}:escalate`,
    approvalIntent: params.pendingApproval.intent,
    approvalReason: params.pendingApproval.reason,
    approvalRequestId: params.pendingApproval.approvalId,
    approvalAllowSession: false,
    approvalAllowAgent: false,
    approvalAllowAll: false,
  };
}

export async function runAgent(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  return withSpan(
    'hybridclaw.agent.run',
    {
      'hybridclaw.session_id': params.sessionId,
      'hybridclaw.agent_id': params.agentId || '',
      'hybridclaw.model': params.model || '',
    },
    async () => runAgentInner(params),
  );
}

async function runAgentInner(
  params: ExecutorRequest,
): Promise<ContainerOutput> {
  const sessionId = params.sessionId;
  const chatbotId = params.chatbotId;
  const model = params.model || HYBRIDAI_MODEL;
  const agentId = params.agentId || DEFAULT_AGENT_ID;
  const channelId = params.channelId || '';
  const media = params.media;
  const blockedTools = mergeBlockedToolNames({ explicit: params.blockedTools });
  const executor = getExecutor(params.executorModeOverride);
  const workspaceRoot =
    params.workspacePathOverride || executor.getWorkspacePath(agentId);
  const preparedMessages = await injectPdfContextMessages({
    sessionId,
    messages: params.messages,
    workspaceRoot,
    media,
  });
  const confidentialRuleSet = isConfidentialRedactionEnabled()
    ? withResolvedSecretLeakRules(sessionId, getConfidentialRuleSet())
    : null;
  const confidential = confidentialRuleSet
    ? createConfidentialRuntimeContext(confidentialRuleSet)
    : createConfidentialRuntimeContext({ rules: [], sourcePath: null });
  const confidentialLeakMiddleware =
    createConfidentialLeakMiddlewareSkill(confidentialRuleSet);
  const dehydratedMessages = confidential.dehydrate(preparedMessages);
  const output = await executor.exec({
    ...params,
    sessionId,
    messages: dehydratedMessages,
    chatbotId,
    model,
    agentId,
    workspacePathOverride: params.workspacePathOverride,
    workspaceDisplayRootOverride: params.workspaceDisplayRootOverride,
    skipContainerSystemPrompt: params.skipContainerSystemPrompt,
    maxTokens: params.maxTokens,
    maxWallClockMs: params.maxWallClockMs,
    inactivityTimeoutMs: params.inactivityTimeoutMs,
    bashProxy: params.bashProxy,
    channelId,
    media,
    blockedTools,
    onTextDelta: confidentialLeakMiddleware
      ? undefined
      : confidential.wrapDelta(params.onTextDelta),
    onThinkingDelta: confidentialLeakMiddleware
      ? undefined
      : confidential.wrapDelta(params.onThinkingDelta),
    onToolProgress: confidential.wrapEvent(
      params.onToolProgress,
      TOOL_PROGRESS_REHYDRATE_FIELDS,
    ),
    onApprovalProgress: confidential.wrapEvent(
      params.onApprovalProgress,
      PENDING_APPROVAL_REHYDRATE_FIELDS,
    ),
  });
  if (!confidential.enabled) return output;
  const rehydratedToolExecutions = output.toolExecutions?.map(
    (execution) =>
      confidential.rehydrateFields(
        execution,
        TOOL_EXECUTION_REHYDRATE_FIELDS,
      ) ?? execution,
  );
  const rehydratedPendingApproval = confidential.rehydrateFields(
    output.pendingApproval,
    PENDING_APPROVAL_REHYDRATE_FIELDS,
  );
  const rehydratedOutput: ContainerOutput = {
    ...output,
    result: output.result
      ? confidential.rehydrate(output.result)
      : output.result,
    error: output.error ? confidential.rehydrate(output.error) : output.error,
    effectiveUserPrompt: output.effectiveUserPrompt
      ? confidential.rehydrate(output.effectiveUserPrompt)
      : output.effectiveUserPrompt,
    toolExecutions: rehydratedToolExecutions ?? output.toolExecutions,
    pendingApproval: rehydratedPendingApproval ?? output.pendingApproval,
  };
  if (!confidentialLeakMiddleware || !rehydratedOutput.result) {
    return rehydratedOutput;
  }

  const middlewareOutcome = await applyClassifierMiddleware(
    'post_receive',
    [confidentialLeakMiddleware],
    {
      sessionId,
      agentId,
      channelId,
      model,
      messages: preparedMessages,
      userContent: getLatestUserTextContent(preparedMessages),
      resultText: rehydratedOutput.result,
      toolExecutions: rehydratedOutput.toolExecutions,
    },
  );
  const escalationEvent = firstEscalationEvent(middlewareOutcome.events);
  if (escalationEvent) {
    for (const extraEvent of escalationEvents(middlewareOutcome.events).slice(
      1,
    )) {
      logger.warn(
        {
          sessionId,
          agentId,
          channelId,
          middlewareId: safeMiddlewareLabel(extraEvent.skillId),
          route: extraEvent.route,
          reason: extraEvent.reason,
        },
        'Additional middleware escalation observed after primary escalation',
      );
    }
    const pendingApproval = buildMiddlewarePendingApproval({
      event: escalationEvent,
      escalationTarget: params.escalationTarget,
    });
    params.onApprovalProgress?.(pendingApproval);
    return {
      ...rehydratedOutput,
      result: pendingApproval.prompt,
      pendingApproval,
      toolExecutions: [
        ...(rehydratedOutput.toolExecutions || []),
        buildMiddlewareToolExecution({
          event: escalationEvent,
          pendingApproval,
          escalationTarget: params.escalationTarget,
        }),
      ],
    };
  }

  return {
    ...rehydratedOutput,
    result: middlewareOutcome.resultText,
  };
}
