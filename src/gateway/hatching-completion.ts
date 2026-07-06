import { recordAuditEvent } from '../audit/audit-events.js';
import type { ToolExecution } from '../types/execution.js';
import {
  claimWorkspaceOnboardingStart,
  completeHatchingAfterMessageSend,
  recordHatchingTurnWithoutMessage,
  type WorkspaceOnboardingTransition,
} from '../workspace.js';

type MessageSend = {
  recipient?: string;
  subject?: string;
};

export type BootstrapHatchingTurnResult = {
  completed: boolean;
  updated: boolean;
  reason: string;
  turnsWithoutMessage?: number;
};

type BootstrapFileName = 'BOOTSTRAP.md' | 'OPENING.md';
type OnboardingAbortRule =
  | WorkspaceOnboardingTransition['rule']
  | 'hatching_no_message_limit';

export interface BootstrapOnboardingAuditContext {
  sessionId: string;
  runId: string;
  agentId: string;
  source: string;
  bootstrapFile: BootstrapFileName;
  channelId?: string | null;
  workspacePath?: string;
}

function buildBaseOnboardingPayload(
  context: BootstrapOnboardingAuditContext,
): Record<string, unknown> {
  return {
    workspaceAgentId: context.agentId,
    source: context.source,
    bootstrapFile: context.bootstrapFile,
    channelId: context.channelId || null,
    workspacePath: context.workspacePath || null,
  };
}

export function recordBootstrapOnboardingStart(
  context: BootstrapOnboardingAuditContext,
): void {
  if (context.bootstrapFile !== 'BOOTSTRAP.md') return;
  const start = claimWorkspaceOnboardingStart({
    agentId: context.agentId,
  });
  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: start.eventType,
      ...buildBaseOnboardingPayload(context),
      ...(start.onboardingStartedAt
        ? { onboardingStartedAt: start.onboardingStartedAt }
        : {}),
      reason:
        start.eventType === 'onboarding.start'
          ? 'bootstrap hatching started'
          : 'bootstrap hatching continued',
    },
  });
}

export function recordBootstrapOnboardingQuickMessage(
  context: BootstrapOnboardingAuditContext,
  params: {
    assistantMessageId: number;
    messageChars: number;
  },
): void {
  if (context.bootstrapFile !== 'BOOTSTRAP.md') return;
  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: 'onboarding.quick_message',
      ...buildBaseOnboardingPayload(context),
      assistantMessageId: params.assistantMessageId,
      messageChars: params.messageChars,
      messageRole: 'assistant',
      reason: 'bootstrap prelude sent',
    },
  });
}

export function recordBootstrapOnboardingUserReply(
  context: BootstrapOnboardingAuditContext,
  params: {
    turnIndex: number;
    messageChars: number;
    mediaCount: number;
  },
): void {
  if (context.bootstrapFile !== 'BOOTSTRAP.md') return;
  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: 'onboarding.user_reply',
      ...buildBaseOnboardingPayload(context),
      turnIndex: params.turnIndex,
      messageChars: params.messageChars,
      mediaCount: params.mediaCount,
      messageRole: 'user',
      reason: 'onboarding user reply received',
    },
  });
}

export function recordBootstrapOnboardingAssistantMessage(
  context: BootstrapOnboardingAuditContext,
  params: {
    turnIndex: number;
    assistantMessageId: number;
    messageChars: number;
    toolCallCount: number;
    messageRole?: 'assistant' | 'approval';
  },
): void {
  if (context.bootstrapFile !== 'BOOTSTRAP.md') return;
  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: 'onboarding.assistant_message',
      ...buildBaseOnboardingPayload(context),
      turnIndex: params.turnIndex,
      assistantMessageId: params.assistantMessageId,
      messageChars: params.messageChars,
      toolCallCount: params.toolCallCount,
      messageRole: params.messageRole || 'assistant',
      reason: 'onboarding assistant message stored',
    },
  });
}

export function recordBootstrapOnboardingAbort(
  context: BootstrapOnboardingAuditContext,
  transition: {
    reason: string;
    rule: OnboardingAbortRule;
    completedAt?: string;
    turnsWithoutMessage?: number;
  },
): void {
  if (context.bootstrapFile !== 'BOOTSTRAP.md') return;
  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: 'onboarding.abort',
      ...buildBaseOnboardingPayload(context),
      reason: transition.reason,
      gatewayRule: transition.rule,
      ...(transition.completedAt
        ? { completedAt: transition.completedAt }
        : {}),
      ...(transition.turnsWithoutMessage
        ? { turnsWithoutMessage: transition.turnsWithoutMessage }
        : {}),
    },
  });
}

function recordBootstrapOnboardingComplete(
  context: BootstrapOnboardingAuditContext,
  result: BootstrapHatchingTurnResult,
): void {
  if (context.bootstrapFile !== 'BOOTSTRAP.md') return;
  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: 'onboarding.complete',
      ...buildBaseOnboardingPayload(context),
      reason: result.reason,
      gatewayRule: 'message_send',
    },
  });
}

export function recordBootstrapHatchingTerminalAudit(params: {
  audit: BootstrapOnboardingAuditContext;
  result: BootstrapHatchingTurnResult | null;
}): void {
  if (!params.result?.completed) return;
  if (params.result.turnsWithoutMessage) {
    recordBootstrapOnboardingAbort(params.audit, {
      reason: params.result.reason,
      rule: 'hatching_no_message_limit',
      turnsWithoutMessage: params.result.turnsWithoutMessage,
    });
    return;
  }

  recordBootstrapOnboardingComplete(params.audit, params.result);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstRecipientCandidate(...values: unknown[]): string {
  for (const value of values) {
    const candidate = readString(value);
    if (candidate) return candidate;
  }
  return '';
}

function readSuccessfulMessageSend(
  execution: ToolExecution,
): MessageSend | null {
  if (execution.name !== 'message') return null;
  if (execution.isError || execution.blocked) return null;

  const args = parseJsonObject(execution.arguments);
  if (!args || readString(args.action).toLowerCase() !== 'send') return null;

  const result = parseJsonObject(execution.result);
  if (result && result.ok === false) return null;

  const recipient = firstRecipientCandidate(
    args.to,
    args.channelId,
    args.target,
    result?.channelId,
  );

  const subject = readString(args.subject) || readString(result?.subject);

  return {
    recipient,
    subject,
  };
}

export function recordBootstrapHatchingTurnResult(params: {
  agentId: string;
  bootstrapFile: 'BOOTSTRAP.md' | 'OPENING.md' | null;
  toolExecutions: ToolExecution[];
  handledAt?: string;
  audit?: BootstrapOnboardingAuditContext;
  deferTerminalAudit?: boolean;
}): BootstrapHatchingTurnResult | null {
  if (params.bootstrapFile !== 'BOOTSTRAP.md') return null;

  const send = params.toolExecutions
    .map(readSuccessfulMessageSend)
    .find((candidate): candidate is MessageSend => Boolean(candidate));
  if (!send) {
    const result = recordHatchingTurnWithoutMessage({
      agentId: params.agentId,
    });
    if (params.audit && result.completed && !params.deferTerminalAudit) {
      recordBootstrapHatchingTerminalAudit({
        audit: params.audit,
        result,
      });
    }
    return result;
  }

  const result = completeHatchingAfterMessageSend({
    agentId: params.agentId,
    recipient: send.recipient,
    subject: send.subject,
    handledAt: params.handledAt,
  });
  if (params.audit && result.completed && !params.deferTerminalAudit) {
    recordBootstrapHatchingTerminalAudit({
      audit: params.audit,
      result,
    });
  }
  return result;
}
