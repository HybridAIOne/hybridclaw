import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rememberPendingApproval } from '../gateway/pending-approvals.js';
import { approveStep, executeWorkflow, returnForRevision } from './executor.js';
import { parseWorkflowDefinitionYaml } from './schema.js';
import {
  getWorkflowDefinition,
  getWorkflowRunState,
  listWorkflowDefinitions,
  listWorkflowRunStates,
  saveWorkflowDefinition,
  type WorkflowRunState,
} from './store.js';

const WORKFLOW_PRESETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'presets',
  'workflows',
);
const DEFAULT_WORKFLOW_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const WORKFLOW_APPROVAL_TTL_ENV = 'HYBRIDCLAW_WORKFLOW_APPROVAL_TTL_MS';

export interface WorkflowRuntimeInitResult {
  loadedDefinitions: string[];
}

export interface WorkflowAdminSummary {
  definitions: ReturnType<typeof listWorkflowDefinitions>;
  runs: WorkflowRunState[];
}

function workflowApprovalId(run: WorkflowRunState): string {
  return `workflow:${run.id}:${run.current_step_id || 'step'}`;
}

function workflowApprovalTtlMs(): number {
  const raw = String(process.env[WORKFLOW_APPROVAL_TTL_ENV] || '').trim();
  if (!raw) return DEFAULT_WORKFLOW_APPROVAL_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_WORKFLOW_APPROVAL_TTL_MS;
}

function requireWorkflowUserId(
  value: string | undefined,
  field: string,
): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`Workflow ${field} requires an explicit user id`);
  }
  return normalized;
}

function workflowPendingApprovalPrompt(run: WorkflowRunState): string {
  const step = run.steps.find((entry) => entry.step_id === run.current_step_id);
  const reasons = step?.escalation?.reasons || [];
  return [
    `Workflow "${run.workflow.name}" paused at step "${run.current_step_id}".`,
    ...(step
      ? [`Owner: ${step.owner_coworker_id}`, `Action: ${step.action}`]
      : []),
    ...(step?.escalation?.stakes && step.escalation.threshold
      ? [
          `Stakes: ${step.escalation.stakes}; threshold: ${step.escalation.threshold}`,
        ]
      : []),
    ...(reasons.length > 0
      ? [`Classifier reasoning: ${reasons.join('; ')}`]
      : []),
    `Approval ID: ${workflowApprovalId(run)}`,
    'Reply `yes` to resume this workflow step, or `no` to leave it paused.',
  ].join('\n');
}

async function rememberWorkflowApproval(params: {
  run: WorkflowRunState;
  sessionId?: string;
  userId: string;
}): Promise<void> {
  if (params.run.status !== 'paused' || !params.run.current_step_id) return;
  const userId = requireWorkflowUserId(params.userId, 'approval');
  await rememberPendingApproval({
    sessionId: params.sessionId || `workflow:${params.run.id}`,
    approvalId: workflowApprovalId(params.run),
    prompt: workflowPendingApprovalPrompt(params.run),
    userId,
    expiresAt: Date.now() + workflowApprovalTtlMs(),
    commandAction: {
      approveArgs: [
        'workflow',
        'approve',
        params.run.id,
        params.run.current_step_id,
      ],
      allowSession: false,
      allowAgent: false,
      allowAll: false,
      denyTitle: 'Workflow Paused',
      denyText: `Workflow \`${params.run.id}\` remains paused at \`${params.run.current_step_id}\`.`,
    },
  });
}

export function initializeWorkflowRuntime(): WorkflowRuntimeInitResult {
  const loadedDefinitions: string[] = [];
  if (!fs.existsSync(WORKFLOW_PRESETS_DIR)) {
    return { loadedDefinitions };
  }

  for (const entry of fs.readdirSync(WORKFLOW_PRESETS_DIR).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const filePath = path.join(WORKFLOW_PRESETS_DIR, entry);
    const definition = parseWorkflowDefinitionYaml(
      fs.readFileSync(filePath, 'utf-8'),
    );
    saveWorkflowDefinition(definition, {
      route: 'workflow.runtime.init',
      source: filePath,
    });
    loadedDefinitions.push(definition.id);
  }
  return { loadedDefinitions };
}

export function getWorkflowAdminSummary(): WorkflowAdminSummary {
  return {
    definitions: listWorkflowDefinitions(),
    runs: listWorkflowRunStates(),
  };
}

export async function startWorkflowRun(params: {
  workflowId: string;
  runId?: string;
  sessionId?: string;
  userId: string;
}): Promise<WorkflowRunState> {
  const userId = requireWorkflowUserId(params.userId, 'start');
  const workflow = getWorkflowDefinition(params.workflowId);
  if (!workflow) {
    throw new Error(`Unknown workflow definition: ${params.workflowId}`);
  }
  const run = await executeWorkflow({
    workflow,
    runId: params.runId,
    sessionId: params.sessionId,
    actor: userId,
    meta: {
      actor: userId,
      route: 'workflow.start',
      source: params.workflowId,
    },
  });
  await rememberWorkflowApproval({
    run,
    sessionId: params.sessionId,
    userId,
  });
  return run;
}

export async function approveWorkflowRunStep(params: {
  runId: string;
  stepId?: string;
  actor: string;
  sessionId?: string;
}): Promise<WorkflowRunState> {
  const current = getWorkflowRunState(params.runId);
  if (!current) throw new Error(`Unknown workflow run: ${params.runId}`);
  const stepId = params.stepId || current.current_step_id;
  if (!stepId) throw new Error(`Workflow run ${params.runId} is not paused.`);
  const run = await approveStep(params.runId, stepId, params.actor, {
    sessionId: params.sessionId,
    meta: {
      actor: params.actor,
      route: 'workflow.approve',
      source: params.runId,
    },
  });
  await rememberWorkflowApproval({
    run,
    sessionId: params.sessionId,
    userId: params.actor,
  });
  return run;
}

export async function returnWorkflowRunStep(params: {
  runId: string;
  stepId: string;
  notes: string;
  actor: string;
  fromStepId?: string;
  sessionId?: string;
}): Promise<WorkflowRunState> {
  const run = await returnForRevision(
    params.runId,
    params.stepId,
    params.notes,
    {
      actor: params.actor,
      fromStepId: params.fromStepId,
      sessionId: params.sessionId,
      meta: {
        actor: params.actor,
        route: 'workflow.return_for_revision',
        source: params.runId,
      },
    },
  );
  await rememberWorkflowApproval({
    run,
    sessionId: params.sessionId,
    userId: params.actor,
  });
  return run;
}
