import { resolveBorderlineAnomalyWithTraceJudge } from './anomaly-trace-judge.js';
import {
  type ApprovalPrelude,
  type ToolApprovalEvaluation,
  TrustedAgentApprovalRuntime,
} from './approval-policy.js';
import { emitRuntimeEvent } from './extensions.js';
import type {
  ChatCompletionResponse,
  ContainerInput,
  EscalationTarget,
  PendingApproval,
  ToolExecution,
} from './types.js';

export type { ApprovalPrelude, ToolApprovalEvaluation };

export const approvalRuntime = new TrustedAgentApprovalRuntime();

approvalRuntime.setApprovalRuleHookEmitter((event) =>
  emitRuntimeEvent({
    event: event.hook,
    kind: event.kind,
    approvalRule: event.ruleName,
    toolName: event.toolName,
    ...(event.actionKey ? { actionKey: event.actionKey } : {}),
    ...(event.decision ? { decision: event.decision } : {}),
  }),
);

export function emitApprovalProgress(approval: PendingApproval): void {
  const payload = Buffer.from(JSON.stringify(approval), 'utf-8').toString(
    'base64',
  );
  console.error(`[approval] ${payload}`);
}

export function buildPendingApproval(
  approval: ToolApprovalEvaluation,
  prompt: string,
  toolName: string,
): PendingApproval {
  if (!approval.requestId) {
    throw new Error('Approval-required tool call is missing a request id.');
  }
  return {
    approvalId: approval.requestId,
    prompt,
    intent: approval.intent,
    reason: approval.reason,
    approvalTier: approval.tier,
    toolName,
    commandPreview: approval.commandPreview,
    allowSession: !approval.pinned,
    allowAgent: !approval.pinned,
    allowAll: !approval.pinned,
    expiresAt:
      typeof approval.expiresAtMs === 'number' &&
      Number.isFinite(approval.expiresAtMs)
        ? approval.expiresAtMs
        : null,
    ...(approval.escalationTarget
      ? { escalationTarget: approval.escalationTarget }
      : {}),
  };
}

export function buildApprovalRequiredToolExecution(params: {
  toolName: string;
  argsJson: string;
  prompt: string;
  approval: ToolApprovalEvaluation;
}): ToolExecution {
  const { toolName, argsJson, prompt, approval } = params;
  return {
    name: toolName,
    arguments: argsJson,
    result: prompt,
    durationMs: 0,
    isError: false,
    blocked: true,
    blockedReason: approval.reason,
    approvalTier: approval.tier,
    approvalBaseTier: approval.baseTier,
    autonomyLevel: approval.autonomyLevel,
    stakes: approval.stakes,
    stakesScore: approval.stakesScore,
    anomaly: approval.anomaly,
    escalationRoute: approval.escalationRoute,
    escalationTarget: approval.escalationTarget,
    approvalDecision: approval.decision,
    approvalActionKey: approval.actionKey,
    approvalIntent: approval.intent,
    approvalReason: approval.reason,
    approvalRequestId: approval.requestId,
    approvalExpiresAt: approval.expiresAtMs,
    approvalAllowSession: !approval.pinned,
    approvalAllowAgent: !approval.pinned,
    approvalAllowAll: !approval.pinned,
  };
}

export function buildApprovalDeniedToolExecution(params: {
  toolName: string;
  argsJson: string;
  denialText: string;
  approval: ToolApprovalEvaluation;
}): ToolExecution {
  const { toolName, argsJson, denialText, approval } = params;
  return {
    name: toolName,
    arguments: argsJson,
    result: denialText,
    durationMs: 0,
    isError: true,
    blocked: true,
    blockedReason: approval.reason,
    approvalTier: approval.tier,
    approvalBaseTier: approval.baseTier,
    autonomyLevel: approval.autonomyLevel,
    stakes: approval.stakes,
    stakesScore: approval.stakesScore,
    anomaly: approval.anomaly,
    escalationRoute: approval.escalationRoute,
    escalationTarget: approval.escalationTarget,
    approvalDecision: approval.decision,
    approvalActionKey: approval.actionKey,
    approvalIntent: approval.intent,
    approvalReason: approval.reason,
    approvalRequestId: approval.requestId,
    approvalExpiresAt: approval.expiresAtMs,
    approvalAllowSession: !approval.pinned,
    approvalAllowAgent: !approval.pinned,
  };
}

export function createToolApprovalResolver(params: {
  latestUserPrompt: string;
  channelId: string;
  escalationTarget?: EscalationTarget;
  taskModels?: ContainerInput['taskModels'];
  fallbackContext: {
    provider: ContainerInput['provider'];
    providerMethod?: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    chatbotId: string;
    requestHeaders?: Record<string, string>;
    isLocal?: boolean;
    contextWindow?: number;
    modelBehavior?: ContainerInput['modelBehavior'];
    thinkingFormat?: 'qwen';
    debugModelResponses?: boolean;
  };
  onModelResponse?: (response: ChatCompletionResponse) => void;
}): (input: {
  toolName: string;
  argsJson: string;
}) => Promise<ToolApprovalEvaluation> {
  return async (input) => {
    const approvalEvaluatedAt = new Date();
    let evaluation = approvalRuntime.evaluateToolCall({
      toolName: input.toolName,
      argsJson: input.argsJson,
      latestUserPrompt: params.latestUserPrompt,
      channelId: params.channelId,
      escalationTarget: params.escalationTarget,
      now: approvalEvaluatedAt,
    });
    const resolved = await resolveBorderlineAnomalyWithTraceJudge({
      evaluation,
      toolName: input.toolName,
      argsJson: input.argsJson,
      latestUserPrompt: params.latestUserPrompt,
      taskModels: params.taskModels,
      fallbackContext: params.fallbackContext,
    });
    if (resolved.response) {
      params.onModelResponse?.(resolved.response);
    }
    const traceJudge = resolved.evaluation.anomaly?.traceJudge;
    if (evaluation.anomaly?.tuple && traceJudge) {
      approvalRuntime.recordAnomalyTraceJudgeResult(
        evaluation.anomaly.tuple,
        traceJudge,
      );
      evaluation = approvalRuntime.evaluateToolCall({
        toolName: input.toolName,
        argsJson: input.argsJson,
        latestUserPrompt: params.latestUserPrompt,
        channelId: params.channelId,
        escalationTarget: params.escalationTarget,
        now: approvalEvaluatedAt,
      });
    }
    return evaluation;
  };
}
