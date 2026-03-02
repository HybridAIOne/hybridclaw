import { appendAuditEvent, createAuditRunId, parseJsonObject, truncateAuditText, type AuditEventPayload } from './audit-trail.js';
import { logStructuredAuditEvent } from './db.js';
import { logger } from './logger.js';
import type { ToolExecution } from './types.js';

export interface RecordAuditEventInput {
  sessionId: string;
  runId: string;
  event: AuditEventPayload;
  parentRunId?: string;
}

export function makeAuditRunId(prefix = 'run'): string {
  return createAuditRunId(prefix);
}

export function recordAuditEvent(input: RecordAuditEventInput): void {
  try {
    const record = appendAuditEvent(input);
    logStructuredAuditEvent(record);
  } catch (err) {
    logger.warn(
      {
        sessionId: input.sessionId,
        runId: input.runId,
        eventType: input.event.type,
        err,
      },
      'Failed to persist structured audit event',
    );
  }
}

function summarizeToolResult(text: string): string {
  return truncateAuditText(text, 280);
}

export function emitToolExecutionAuditEvents(input: {
  sessionId: string;
  runId: string;
  toolExecutions: ToolExecution[];
}): void {
  const { sessionId, runId, toolExecutions } = input;
  toolExecutions.forEach((execution, index) => {
    const toolCallId = `${runId}:tool:${index + 1}`;
    const argumentsObject = parseJsonObject(execution.arguments || '{}');

    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'tool.call',
        toolCallId,
        toolName: execution.name,
        arguments: argumentsObject,
      },
    });

    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'authorization.check',
        action: `tool:${execution.name}`,
        resource: 'container.sandbox',
        allowed: !execution.blocked,
        reason: execution.blockedReason || 'allowed',
      },
    });

    if (execution.blocked) {
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'approval.request',
          toolCallId,
          action: `tool:${execution.name}`,
          description: execution.blockedReason || 'Blocked by security policy',
        },
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'approval.response',
          toolCallId,
          action: `tool:${execution.name}`,
          description: execution.blockedReason || 'Blocked by security policy',
          approved: false,
          approvedBy: 'policy-engine',
          method: 'policy',
          policyName: 'security-hook',
        },
      });
    }

    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'tool.result',
        toolCallId,
        toolName: execution.name,
        isError: Boolean(execution.isError),
        resultSummary: summarizeToolResult(execution.result || ''),
        durationMs: execution.durationMs,
      },
    });
  });
}
