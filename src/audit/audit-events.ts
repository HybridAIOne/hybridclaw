import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { logStructuredAuditEvent } from '../memory/db.js';
import {
  redactHighEntropyStrings,
  redactSecretsDeep,
  URL_SECRET_QUERY_PARAM_RE,
} from '../security/redact.js';
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
    recordAuditEventStrict(input);
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

export function recordAuditEventStrict(input: RecordAuditEventInput): void {
  const record = appendAuditEvent(input);
  logStructuredAuditEvent(record);
}

function summarizeToolResult(text: string): string {
  return truncateAuditText(text, 280);
}

function previewToolResult(text: string): string {
  return truncateAuditText(fullToolResult(text), 4_000);
}

function fullToolResult(text: string): string {
  const redacted = redactHighEntropyStrings(
    String(redactSecretsDeep(text)).replace(
      URL_SECRET_QUERY_PARAM_RE,
      '$1***REDACTED***',
    ),
  );
  const toolResultsConfig = getRuntimeConfig().audit?.toolResults;
  if (toolResultsConfig?.mode === 'truncate') {
    return truncatePreservingWhitespace(
      redacted,
      toolResultsConfig.maxChars || 4_000,
    );
  }
  return redacted;
}

function truncatePreservingWhitespace(text: string, maxChars: number): string {
  const safeMaxChars = Number.isFinite(maxChars)
    ? Math.max(1, Math.trunc(maxChars))
    : 4_000;
  if (text.length <= safeMaxChars) return text;
  return `${text.slice(0, safeMaxChars)}...`;
}

type ApprovalTier = NonNullable<ToolExecution['approvalTier']>;
type ApprovalDecision = NonNullable<ToolExecution['approvalDecision']>;
type EscalationRoute = NonNullable<ToolExecution['escalationRoute']>;

function resolveAutonomyEscalationRoute(params: {
  decision: ApprovalDecision;
  tier: ApprovalTier;
  blocked: boolean;
}): EscalationRoute {
  if (params.blocked || params.decision === 'denied') return 'policy_denial';
  if (params.decision === 'required') return 'approval_request';
  if (params.tier === 'yellow' && params.decision === 'implicit') {
    return 'implicit_notice';
  }
  return 'none';
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

export function emitToolExecutionAuditEvents(input: {
  sessionId: string;
  runId: string;
  toolExecutions: ToolExecution[];
}): void {
  const { sessionId, runId, toolExecutions } = input;
  toolExecutions.forEach((execution, index) => {
    const toolCallId = `${runId}:tool:${index + 1}`;
    const effectiveTier = execution.approvalTier || 'green';
    const effectiveBaseTier =
      execution.approvalBaseTier || execution.approvalTier || 'green';
    const effectiveDecision = execution.approvalDecision || 'auto';
    const effectiveEscalationRoute =
      execution.escalationRoute ||
      resolveAutonomyEscalationRoute({
        decision: effectiveDecision,
        tier: effectiveTier,
        blocked: Boolean(execution.blocked),
      });
    const effectiveReason =
      execution.approvalReason ||
      execution.blockedReason ||
      (effectiveDecision === 'auto'
        ? 'allowed'
        : `approval:${effectiveDecision}`);
    const argumentsObject = parseJsonObject(execution.arguments || '{}');
    const auditArguments = sanitizeAuditArguments(
      execution.name,
      argumentsObject,
    );
    const anomaly = execution.anomaly
      ? {
          score: execution.anomaly.score,
          reason: execution.anomaly.reason,
          threshold: execution.anomaly.threshold,
          status: execution.anomaly.status,
          model: execution.anomaly.model,
          trajectoryCount: execution.anomaly.trajectoryCount,
          tuple: execution.anomaly.tuple,
          traceJudge: execution.anomaly.traceJudge || null,
        }
      : {
          score: 0,
          reason: 'behavior anomaly reranker not evaluated',
          threshold: null,
          status: 'abstained',
          model: 'order2_markov_frequency_v1',
          trajectoryCount: 0,
          tuple: null,
        };

    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'tool.call',
        toolCallId,
        toolName: execution.name,
        arguments: auditArguments,
        anomaly,
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
        reason: effectiveReason,
        anomaly,
      },
    });

    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'autonomy.decision',
        toolCallId,
        action: execution.approvalActionKey || `tool:${execution.name}`,
        autonomyLevel: execution.autonomyLevel || 'full-autonomous',
        stakes: execution.stakes || 'low',
        escalationRoute: effectiveEscalationRoute,
        approvalTier: effectiveTier,
        approvalBaseTier: effectiveBaseTier,
        approvalDecision: effectiveDecision,
        reason: effectiveReason,
        anomaly,
      },
    });

    if (effectiveEscalationRoute !== 'none') {
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'escalation.decision',
          toolCallId,
          action: execution.approvalActionKey || `tool:${execution.name}`,
          proposedAction:
            execution.approvalIntent ||
            execution.approvalActionKey ||
            `tool:${execution.name}`,
          escalationRoute: effectiveEscalationRoute,
          target: execution.escalationTarget || null,
          stakes: execution.stakes || 'low',
          classifier: execution.stakesScore?.classifier || null,
          classifierReasoning: execution.stakesScore?.reasons || [],
          approvalDecision: effectiveDecision,
          reason: effectiveReason,
          anomaly,
        },
      });
    }

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
            policyName: 'trusted-agent',
            anomaly,
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
            policyName: 'trusted-agent',
            anomaly,
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
          anomaly,
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
          anomaly,
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
        resultSummary: summarizeToolResult(execution.result || ''),
        resultPreview: previewToolResult(execution.result || ''),
        resultFull: fullToolResult(execution.result || ''),
        durationMs: execution.durationMs,
        anomaly,
      },
    });
  });
}
