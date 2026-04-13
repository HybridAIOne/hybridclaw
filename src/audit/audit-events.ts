import { logger } from '../logger.js';
import { logStructuredAuditEvent } from '../memory/db.js';
import type { ToolExecution } from '../types/execution.js';
import {
  type AuditEventPayload,
  appendAuditEvent,
  createAuditRunId,
  parseJsonObject,
  truncateAuditText,
} from './audit-trail.js';

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

function summarizeAuditToolResult(toolName: string, text: string): string {
  if (!toolName.startsWith('browser_')) {
    return summarizeToolResult(text);
  }
  const parsed = parseJsonObject(text);
  if (!Object.hasOwn(parsed, 'live_url')) {
    return summarizeToolResult(text);
  }
  const sanitized = {
    ...parsed,
    live_url: '[REDACTED]',
  };
  return summarizeToolResult(JSON.stringify(sanitized));
}

const SENSITIVE_ARG_KEY_RE =
  /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|session)/i;

function sanitizeAuditArguments(toolName: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuditArguments(toolName, entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_ARG_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (toolName === 'browser_type' && key === 'text') {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeAuditArguments(toolName, raw);
  }
  return out;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function countArrayItems(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function emitBrowserToolAuditEvents(input: {
  sessionId: string;
  runId: string;
  toolCallId: string;
  execution: ToolExecution;
}): void {
  const result = parseJsonObject(input.execution.result || '{}');
  const executionStrategy = asTrimmedString(result.execution_strategy);
  const cloudSessionId =
    asTrimmedString(result.cloud_session_id) ||
    asTrimmedString(result.session_id);

  if (executionStrategy?.startsWith('cloud-') && cloudSessionId) {
    recordAuditEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      event: {
        type: 'browser.session',
        toolCallId: input.toolCallId,
        toolName: input.execution.name,
        executionStrategy,
        cloudSessionId,
      },
    });
  }

  if (input.execution.name !== 'browser_agent_task' || !cloudSessionId) {
    return;
  }

  const stepCount = asFiniteNumber(result.step_count);
  const totalInputTokens = asFiniteNumber(result.total_input_tokens);
  const totalOutputTokens = asFiniteNumber(result.total_output_tokens);
  const recordingCount = countArrayItems(result.recording_paths);

  recordAuditEvent({
    sessionId: input.sessionId,
    runId: input.runId,
    event: {
      type: 'browser.agent_task',
      toolCallId: input.toolCallId,
      sessionId: cloudSessionId,
      status: asTrimmedString(result.status) || 'unknown',
      executionStrategy: executionStrategy || 'cloud-agent',
      isTaskSuccessful:
        typeof result.is_task_successful === 'boolean'
          ? result.is_task_successful
          : null,
      ...(stepCount != null ? { stepCount } : {}),
      ...(asTrimmedString(result.llm_cost_usd)
        ? { llmCostUsd: asTrimmedString(result.llm_cost_usd) }
        : {}),
      ...(asTrimmedString(result.proxy_cost_usd)
        ? { proxyCostUsd: asTrimmedString(result.proxy_cost_usd) }
        : {}),
      ...(asTrimmedString(result.browser_cost_usd)
        ? { browserCostUsd: asTrimmedString(result.browser_cost_usd) }
        : {}),
      ...(asTrimmedString(result.total_cost_usd)
        ? { totalCostUsd: asTrimmedString(result.total_cost_usd) }
        : {}),
      ...(totalInputTokens != null ? { totalInputTokens } : {}),
      ...(totalOutputTokens != null ? { totalOutputTokens } : {}),
      ...(asTrimmedString(result.profile_id)
        ? { profileId: asTrimmedString(result.profile_id) }
        : {}),
      ...(asTrimmedString(result.workspace_id)
        ? { workspaceId: asTrimmedString(result.workspace_id) }
        : {}),
      ...(recordingCount != null ? { recordingCount } : {}),
    },
  });
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
    const auditArguments = sanitizeAuditArguments(
      execution.name,
      argumentsObject,
    );

    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'tool.call',
        toolCallId,
        toolName: execution.name,
        arguments: auditArguments,
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
        reason:
          execution.blockedReason ||
          execution.approvalReason ||
          (execution.approvalDecision
            ? `approval:${execution.approvalDecision}`
            : 'allowed'),
      },
    });

    const isRedApprovalAction =
      execution.approvalTier === 'red' || execution.approvalBaseTier === 'red';
    const decision = execution.approvalDecision;
    const hasExplicitApprovalFlow =
      decision === 'required' ||
      decision === 'denied' ||
      decision === 'approved_once' ||
      decision === 'approved_session' ||
      decision === 'approved_agent' ||
      decision === 'approved_all' ||
      decision === 'approved_fullauto';
    if (isRedApprovalAction || hasExplicitApprovalFlow) {
      const description =
        execution.approvalReason ||
        execution.blockedReason ||
        `Approval flow for tool ${execution.name}`;
      if (decision === 'required' || decision === 'denied') {
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'approval.request',
            toolCallId,
            action: execution.approvalActionKey || `tool:${execution.name}`,
            description,
            policyName: 'trusted-coworker',
          },
        });
      }

      const approved =
        decision === 'approved_once' ||
        decision === 'approved_session' ||
        decision === 'approved_agent' ||
        decision === 'approved_all' ||
        decision === 'approved_fullauto' ||
        decision === 'promoted';
      const pending = decision === 'required';
      if (decision && decision !== 'auto' && decision !== 'implicit') {
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'approval.response',
            toolCallId,
            action: execution.approvalActionKey || `tool:${execution.name}`,
            description: pending
              ? `${description} (pending user response)`
              : description,
            approved,
            approvedBy: pending
              ? 'pending-user-response'
              : decision === 'approved_fullauto'
                ? 'fullauto'
                : approved
                  ? 'local-user'
                  : 'policy-engine',
            method:
              decision === 'approved_fullauto'
                ? 'automatic'
                : pending || approved
                  ? 'prompt'
                  : 'policy',
            policyName: 'trusted-coworker',
          },
        });
      }
    } else if (execution.blocked) {
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
        blocked: Boolean(execution.blocked),
        resultSummary: summarizeAuditToolResult(
          execution.name,
          execution.result || '',
        ),
        durationMs: execution.durationMs,
      },
    });

    emitBrowserToolAuditEvents({
      sessionId,
      runId,
      toolCallId,
      execution,
    });
  });
}
