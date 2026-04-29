import { getWorkflowRunState, type WorkflowRunState } from './store.js';

export function renderWorkflowRunState(run: WorkflowRunState): string {
  const lines = [
    `${run.workflow.name} (${run.id})`,
    `Status: ${run.status}${run.current_step_id ? `, active: ${run.current_step_id}` : ''}`,
  ];
  for (const step of run.steps) {
    const markers = [
      run.current_step_id === step.step_id ? 'active' : '',
      step.escalation?.route === 'approval_request' &&
      !step.escalation.approved_at
        ? 'pending approval'
        : '',
      step.escalation?.stakes && step.escalation.threshold
        ? `stakes ${step.escalation.stakes} / threshold ${step.escalation.threshold}`
        : '',
      step.revisions.length > 0 ? `${step.revisions.length} revision(s)` : '',
    ].filter(Boolean);
    lines.push(
      `- ${step.step_id}: ${step.status} (${step.owner_coworker_id})${markers.length > 0 ? ` [${markers.join(', ')}]` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderWorkflowRunStateById(runId: string): string {
  const run = getWorkflowRunState(runId);
  if (!run) throw new Error(`Unknown workflow run: ${runId}`);
  return renderWorkflowRunState(run);
}
