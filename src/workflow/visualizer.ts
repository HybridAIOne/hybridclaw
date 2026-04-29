import { getWorkflowRunState, type WorkflowRunState } from './store.js';

export interface WorkflowRunStepView {
  id: string;
  ownerCoworkerId: string;
  action: string;
  status: string;
  attempts: number;
  active: boolean;
  pendingApproval: boolean;
  stakes?: string;
  threshold?: string;
  revisionCount: number;
  artifactCount: number;
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  name: string;
  status: string;
  currentStepId?: string;
  steps: WorkflowRunStepView[];
}

export function buildWorkflowRunView(run: WorkflowRunState): WorkflowRunView {
  return {
    id: run.id,
    workflowId: run.workflow.id,
    name: run.workflow.name,
    status: run.status,
    ...(run.current_step_id ? { currentStepId: run.current_step_id } : {}),
    steps: run.steps.map((step) => ({
      id: step.step_id,
      ownerCoworkerId: step.owner_coworker_id,
      action: step.action,
      status: step.status,
      attempts: step.attempts,
      active: run.current_step_id === step.step_id,
      pendingApproval:
        step.escalation?.route === 'approval_request' &&
        !step.escalation.approved_at,
      ...(step.escalation?.stakes ? { stakes: step.escalation.stakes } : {}),
      ...(step.escalation?.threshold
        ? { threshold: step.escalation.threshold }
        : {}),
      revisionCount: step.revisions.length,
      artifactCount: step.artifacts.length,
    })),
  };
}

export function renderWorkflowRunState(run: WorkflowRunState): string {
  const view = buildWorkflowRunView(run);
  const lines = [
    `${view.name} (${view.id})`,
    `Status: ${view.status}${view.currentStepId ? `, active: ${view.currentStepId}` : ''}`,
  ];
  for (const step of view.steps) {
    const markers = [
      step.active ? 'active' : '',
      step.pendingApproval ? 'pending approval' : '',
      step.stakes && step.threshold
        ? `stakes ${step.stakes} / threshold ${step.threshold}`
        : '',
      step.revisionCount > 0 ? `${step.revisionCount} revision(s)` : '',
    ].filter(Boolean);
    lines.push(
      `- ${step.id}: ${step.status} (${step.ownerCoworkerId})${markers.length > 0 ? ` [${markers.join(', ')}]` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderWorkflowRunStateById(runId: string): string {
  const run = getWorkflowRunState(runId);
  if (!run) throw new Error(`Unknown workflow run: ${runId}`);
  return renderWorkflowRunState(run);
}
