import { makeAuditRunId, recordAuditEvent } from './audit-events.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';

const INSTRUCTION_APPROVAL_ACTION = 'instruction:approve';
const INSTRUCTION_APPROVAL_POLICY = 'instruction-integrity';

let auditReady = false;
let auditInitAttempted = false;

export interface InstructionApprovalAuditContext {
  sessionId: string;
  runId: string;
  toolCallId: string;
  source: string;
}

function ensureAuditReady(): boolean {
  if (auditInitAttempted) return auditReady;
  auditInitAttempted = true;
  try {
    initDatabase({ quiet: true });
    auditReady = true;
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize DB for instruction approval audit');
    auditReady = false;
  }
  return auditReady;
}

export function beginInstructionApprovalAudit(input: {
  sessionId: string;
  source: string;
  description: string;
}): InstructionApprovalAuditContext {
  const runId = makeAuditRunId('instructions');
  const toolCallId = `${runId}:approval:1`;
  const context: InstructionApprovalAuditContext = {
    sessionId: input.sessionId,
    runId,
    toolCallId,
    source: input.source,
  };

  if (!ensureAuditReady()) return context;

  recordAuditEvent({
    sessionId: context.sessionId,
    runId: context.runId,
    event: {
      type: 'approval.request',
      toolCallId: context.toolCallId,
      action: INSTRUCTION_APPROVAL_ACTION,
      description: input.description,
      policyName: INSTRUCTION_APPROVAL_POLICY,
      source: context.source,
    },
  });

  return context;
}

export function completeInstructionApprovalAudit(input: {
  context: InstructionApprovalAuditContext;
  approved: boolean;
  approvedBy: string;
  method: string;
  description: string;
}): void {
  if (!ensureAuditReady()) return;

  recordAuditEvent({
    sessionId: input.context.sessionId,
    runId: input.context.runId,
    event: {
      type: 'approval.response',
      toolCallId: input.context.toolCallId,
      action: INSTRUCTION_APPROVAL_ACTION,
      description: input.description,
      approved: input.approved,
      approvedBy: input.approvedBy,
      method: input.method,
      policyName: INSTRUCTION_APPROVAL_POLICY,
      source: input.context.source,
    },
  });
}
