import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { logger } from '../logger.js';
import { resourceHygieneDoctorChecks } from './checks/resource-hygiene.js';
import type { DiagResult, DoctorFixOutcome } from './types.js';
import { runChecks, summarizeCounts, toErrorMessage } from './utils.js';

export const RESOURCE_HYGIENE_MAINTENANCE_SESSION_ID =
  'scheduler:resource-hygiene';

export interface ResourceHygieneMaintenanceReport {
  generatedAt: string;
  results: DiagResult[];
  summary: ReturnType<typeof summarizeCounts>;
  fixes: DoctorFixOutcome[];
  approvalRequired: Array<Pick<DiagResult, 'category' | 'label' | 'message'>>;
}

async function applySafeWarnFixes(
  results: DiagResult[],
): Promise<DoctorFixOutcome[]> {
  const outcomes: DoctorFixOutcome[] = [];

  for (const result of results) {
    if (!result.fix || result.severity === 'ok') continue;

    if (result.fix.requiresApproval) {
      outcomes.push({
        category: result.category,
        label: result.label,
        status: 'skipped',
        message: 'Skipped because manual approval is required',
      });
      continue;
    }

    if (result.severity !== 'warn') {
      outcomes.push({
        category: result.category,
        label: result.label,
        status: 'skipped',
        message: 'Skipped because only warn-level fixes auto-apply',
      });
      continue;
    }

    try {
      await result.fix.apply();
      outcomes.push({
        category: result.category,
        label: result.label,
        status: 'applied',
        message:
          result.fix.summary || `Applied fix for ${result.label.toLowerCase()}`,
      });
    } catch (error) {
      outcomes.push({
        category: result.category,
        label: result.label,
        status: 'failed',
        message: toErrorMessage(error),
      });
    }
  }

  return outcomes;
}

export async function runResourceHygieneMaintenance(): Promise<ResourceHygieneMaintenanceReport> {
  const generatedAt = new Date().toISOString();
  const trigger = 'scheduler';
  const runId = makeAuditRunId('maintenance');
  const checks = resourceHygieneDoctorChecks();

  recordAuditEvent({
    sessionId: RESOURCE_HYGIENE_MAINTENANCE_SESSION_ID,
    runId,
    event: {
      type: 'maintenance.resource_hygiene.start',
      trigger,
      generatedAt,
    },
  });

  const initialResults = await runChecks(checks);
  const fixes = await applySafeWarnFixes(initialResults);
  const finalResults = fixes.some((fix) => fix.status === 'applied')
    ? await runChecks(checks)
    : initialResults;
  const summary = summarizeCounts(finalResults);
  const approvalRequired = finalResults
    .filter(
      (result) =>
        result.severity !== 'ok' && result.fix?.requiresApproval === true,
    )
    .map((result) => ({
      category: result.category,
      label: result.label,
      message: result.message,
    }));

  if (approvalRequired.length > 0) {
    recordAuditEvent({
      sessionId: RESOURCE_HYGIENE_MAINTENANCE_SESSION_ID,
      runId,
      event: {
        type: 'approval.request',
        action: 'maintenance:resource-hygiene',
        description: approvalRequired
          .map((result) => `${result.label}: ${result.message}`)
          .join('; '),
        policyName: 'resource-hygiene',
        source: trigger,
      },
    });
  }

  const appliedFixLabels = fixes
    .filter((fix) => fix.status === 'applied')
    .map((fix) => fix.label);
  const failedFixLabels = fixes
    .filter((fix) => fix.status === 'failed')
    .map((fix) => `${fix.label}: ${fix.message}`);
  const approvalRequiredLabels = approvalRequired.map((result) => result.label);

  recordAuditEvent({
    sessionId: RESOURCE_HYGIENE_MAINTENANCE_SESSION_ID,
    runId,
    event: {
      type: 'maintenance.resource_hygiene.summary',
      trigger,
      generatedAt,
      summary,
      appliedFixes: appliedFixLabels,
      failedFixes: failedFixLabels,
      approvalRequired: approvalRequiredLabels,
    },
  });

  logger.info(
    {
      trigger,
      summary,
      appliedFixes: appliedFixLabels,
      failedFixes: failedFixLabels,
      approvalRequired: approvalRequiredLabels,
    },
    'Resource hygiene maintenance completed',
  );

  return {
    generatedAt,
    results: finalResults,
    summary,
    fixes,
    approvalRequired,
  };
}
