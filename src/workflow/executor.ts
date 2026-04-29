import { randomUUID } from 'node:crypto';
import type {
  StakesClassificationInput,
  StakesClassifier,
  StakesLevel,
  StakesScore,
} from '../../container/shared/stakes-classifier.js';
import { type A2AEnvelope, createA2AEnvelope } from '../a2a/envelope.js';
import { saveA2AEnvelope } from '../a2a/store.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type { AuditEventPayload } from '../audit/audit-trail.js';
import type { RuntimeConfigChangeMeta } from '../config/runtime-config-revisions.js';
import {
  parseWorkflowDefinitionYaml,
  validateWorkflowDefinition,
  WORKFLOW_STAKES_ORDER,
  type WorkflowDefinition,
  type WorkflowStep,
} from './schema.js';
import { createWorkflowStakesClassifier } from './stakes-classifier.js';
import {
  getWorkflowRunState,
  saveWorkflowDefinition,
  saveWorkflowRunState,
  type WorkflowRunEvent,
  type WorkflowRunState,
  type WorkflowStepRunState,
} from './store.js';

export interface WorkflowDispatchInput {
  run: WorkflowRunState;
  step: WorkflowStep;
  sender_coworker_id: string;
}

export interface WorkflowDispatchResult {
  artifact?: unknown;
  envelope?: A2AEnvelope;
}

export type WorkflowStepDispatcher = (
  input: WorkflowDispatchInput,
) => Promise<WorkflowDispatchResult> | WorkflowDispatchResult;

export interface ExecuteWorkflowInput {
  workflow: WorkflowDefinition | string;
  runId?: string;
  threadId?: string;
  initiatorCoworkerId?: string;
  stakesClassifier?: StakesClassifier;
  dispatchStep?: WorkflowStepDispatcher;
  sessionId?: string;
  actor?: string;
  meta?: RuntimeConfigChangeMeta;
}

export interface ResumeWorkflowInput {
  runId: string;
  stakesClassifier?: StakesClassifier;
  dispatchStep?: WorkflowStepDispatcher;
  sessionId?: string;
  actor?: string;
  meta?: RuntimeConfigChangeMeta;
}

function nowIso(): string {
  return new Date().toISOString();
}

function event(
  type: string,
  params: Omit<WorkflowRunEvent, 'type' | 'created_at'> = {},
): WorkflowRunEvent {
  return {
    ...params,
    type,
    created_at: nowIso(),
  };
}

function parseWorkflow(input: WorkflowDefinition | string): WorkflowDefinition {
  if (typeof input === 'string') return parseWorkflowDefinitionYaml(input);
  return validateWorkflowDefinition(input);
}

function firstStepId(workflow: WorkflowDefinition): string {
  const targets = new Set(
    workflow.transitions.map((transition) => transition.to),
  );
  const rootStep = workflow.steps.find((step) => !targets.has(step.id));
  if (!rootStep) {
    throw new Error(`Workflow ${workflow.id} has no root step`);
  }
  return rootStep.id;
}

function nextStepId(
  workflow: WorkflowDefinition,
  currentStepId: string,
): string | undefined {
  const outgoing = workflow.transitions.filter(
    (transition) => transition.from === currentStepId,
  );
  if (outgoing.length > 1) {
    throw new Error(`Workflow step ${currentStepId} has multiple transitions`);
  }
  return outgoing[0]?.to;
}

function makeInitialRun(params: {
  workflow: WorkflowDefinition;
  runId?: string;
  threadId?: string;
  initiatorCoworkerId?: string;
}): WorkflowRunState {
  const id = params.runId?.trim() || `wf_${randomUUID()}`;
  const threadId = params.threadId?.trim() || id;
  const initiator = params.initiatorCoworkerId?.trim() || DEFAULT_AGENT_ID;
  const createdAt = nowIso();
  return {
    version: 1,
    id,
    workflow: params.workflow,
    thread_id: threadId,
    initiator_coworker_id: initiator,
    status: 'running',
    current_step_id: firstStepId(params.workflow),
    created_at: createdAt,
    updated_at: createdAt,
    steps: params.workflow.steps.map((step) => ({
      step_id: step.id,
      owner_coworker_id: step.owner_coworker_id,
      action: step.action,
      status: 'pending',
      attempts: 0,
      artifacts: [],
      revisions: [],
    })),
    events: [
      event('workflow.run.created', {
        message: `Started workflow ${params.workflow.id}`,
      }),
    ],
  };
}

function findStep(workflow: WorkflowDefinition, stepId: string): WorkflowStep {
  const step = workflow.steps.find((entry) => entry.id === stepId);
  if (!step) throw new Error(`Unknown workflow step: ${stepId}`);
  return step;
}

function findStepState(
  run: WorkflowRunState,
  stepId: string,
): WorkflowStepRunState {
  const state = run.steps.find((entry) => entry.step_id === stepId);
  if (!state) throw new Error(`Unknown workflow step state: ${stepId}`);
  return state;
}

function recordWorkflowAudit(
  run: WorkflowRunState,
  sessionId: string | undefined,
  payload: AuditEventPayload,
): void {
  recordAuditEvent({
    sessionId: sessionId || run.id,
    runId: makeAuditRunId(`workflow-${run.id}`),
    event: payload,
  });
}

function classifyStep(
  classifier: StakesClassifier,
  workflow: WorkflowDefinition,
  step: WorkflowStep,
): StakesScore {
  const input: StakesClassificationInput = {
    toolName: 'workflow_step',
    args: {
      workflow_id: workflow.id,
      step_id: step.id,
      action: step.action,
      owner_coworker_id: step.owner_coworker_id,
    },
    actionKey: `workflow:${workflow.id}:${step.id}`,
    intent: step.action,
    reason: 'workflow step dispatch',
    target: step.action,
    approvalTier: 'green',
    pathHints: [],
    hostHints: [],
    writeIntent: true,
    pinned: false,
  };
  return classifier.classify(input);
}

function exceedsThreshold(score: StakesScore, threshold: StakesLevel): boolean {
  return WORKFLOW_STAKES_ORDER[score.level] > WORKFLOW_STAKES_ORDER[threshold];
}

async function defaultDispatchStep(
  input: WorkflowDispatchInput,
): Promise<WorkflowDispatchResult> {
  const envelope = createA2AEnvelope({
    sender_agent_id: input.sender_coworker_id,
    recipient_agent_id: input.step.owner_coworker_id,
    thread_id: input.run.thread_id,
    intent: 'handoff',
    content: input.step.action,
  });
  const saved = saveA2AEnvelope(envelope, {
    route: 'workflow.dispatch',
    source: input.run.workflow.id,
  });
  return {
    envelope: saved,
    artifact: {
      envelope_id: saved.id,
      recipient_coworker_id: saved.recipient_agent_id,
    },
  };
}

function senderForStep(run: WorkflowRunState, stepId: string): string {
  const incoming = run.workflow.transitions.find(
    (transition) => transition.to === stepId,
  );
  if (!incoming) return run.initiator_coworker_id;
  return findStep(run.workflow, incoming.from).owner_coworker_id;
}

function markRunUpdated(run: WorkflowRunState): void {
  run.updated_at = nowIso();
}

function evaluateStepStakes(
  run: WorkflowRunState,
  step: WorkflowStep,
  classifier: StakesClassifier,
  sessionId?: string,
): 'continue' | 'paused' {
  const stepState = findStepState(run, step.id);
  if (!step.stakes_threshold || stepState.escalation?.approved_at) {
    return 'continue';
  }

  const score = classifyStep(classifier, run.workflow, step);
  if (exceedsThreshold(score, step.stakes_threshold)) {
    stepState.status = 'paused';
    stepState.paused_at = nowIso();
    stepState.escalation = {
      route: 'approval_request',
      threshold: step.stakes_threshold,
      stakes: score.level,
      classifier: score.classifier,
      reasons: score.reasons,
      requested_at: stepState.paused_at,
    };
    run.status = 'paused';
    run.events.push(
      event('workflow.step.escalated', {
        step_id: step.id,
        stakes: score.level,
        threshold: step.stakes_threshold,
        classifier: score.classifier,
        reasons: score.reasons,
        message: `Paused ${step.id} for stakes escalation`,
      }),
    );
    recordWorkflowAudit(run, sessionId, {
      type: 'workflow.escalation',
      workflowId: run.workflow.id,
      runId: run.id,
      stepId: step.id,
      stakes: score.level,
      threshold: step.stakes_threshold,
      route: 'approval_request',
      classifier: score.classifier,
      reasons: score.reasons,
    });
    markRunUpdated(run);
    return 'paused';
  }

  stepState.escalation = {
    route: 'none',
    threshold: step.stakes_threshold,
    stakes: score.level,
    classifier: score.classifier,
    reasons: score.reasons,
  };
  run.events.push(
    event('workflow.step.auto_execute', {
      step_id: step.id,
      stakes: score.level,
      threshold: step.stakes_threshold,
      classifier: score.classifier,
      reasons: score.reasons,
    }),
  );
  recordWorkflowAudit(run, sessionId, {
    type: 'workflow.auto_execute',
    workflowId: run.workflow.id,
    runId: run.id,
    stepId: step.id,
    stakes: score.level,
    threshold: step.stakes_threshold,
    classifier: score.classifier,
    reasons: score.reasons,
  });
  return 'continue';
}

async function dispatchAndRecord(
  run: WorkflowRunState,
  step: WorkflowStep,
  dispatchStep: WorkflowStepDispatcher,
): Promise<'completed' | 'failed'> {
  const stepState = findStepState(run, step.id);
  const startedAt = nowIso();
  stepState.status = 'running';
  stepState.started_at = startedAt;
  stepState.attempts += 1;
  run.events.push(
    event('workflow.step.started', {
      step_id: step.id,
      owner_coworker_id: step.owner_coworker_id,
    }),
  );

  try {
    const result = await dispatchStep({
      run,
      step,
      sender_coworker_id: senderForStep(run, step.id),
    });
    const completedAt = nowIso();
    stepState.status = 'completed';
    stepState.completed_at = completedAt;
    stepState.artifacts.push({
      revision: stepState.artifacts.length + 1,
      created_at: completedAt,
      value: result.artifact ?? result.envelope ?? null,
    });
    run.events.push(
      event('workflow.step.completed', {
        step_id: step.id,
        owner_coworker_id: step.owner_coworker_id,
      }),
    );
    markRunUpdated(run);
    return 'completed';
  } catch (error) {
    const failedAt = nowIso();
    stepState.status = 'failed';
    stepState.failed_at = failedAt;
    stepState.error = error instanceof Error ? error.message : String(error);
    run.status = 'failed';
    run.failed_at = failedAt;
    run.error = stepState.error;
    run.events.push(
      event('workflow.step.failed', {
        step_id: step.id,
        message: stepState.error,
      }),
    );
    markRunUpdated(run);
    return 'failed';
  }
}

async function continueRun(
  run: WorkflowRunState,
  options: {
    stakesClassifier?: StakesClassifier;
    dispatchStep?: WorkflowStepDispatcher;
    sessionId?: string;
    meta?: RuntimeConfigChangeMeta;
  },
): Promise<WorkflowRunState> {
  const dispatchStep = options.dispatchStep || defaultDispatchStep;
  const stakesClassifier =
    options.stakesClassifier || createWorkflowStakesClassifier();
  run.status = 'running';

  while (run.current_step_id) {
    const step = findStep(run.workflow, run.current_step_id);
    if (
      evaluateStepStakes(run, step, stakesClassifier, options.sessionId) ===
      'paused'
    ) {
      return saveWorkflowRunState(run, options.meta);
    }

    if ((await dispatchAndRecord(run, step, dispatchStep)) === 'failed') {
      return saveWorkflowRunState(run, options.meta);
    }

    const next = nextStepId(run.workflow, step.id);
    if (!next) {
      run.status = 'completed';
      run.completed_at = nowIso();
      run.current_step_id = undefined;
      run.events.push(
        event('workflow.run.completed', {
          message: `Completed workflow ${run.workflow.id}`,
        }),
      );
      markRunUpdated(run);
      return saveWorkflowRunState(run, options.meta);
    }
    run.current_step_id = next;
    markRunUpdated(run);
  }

  run.status = 'completed';
  run.completed_at = nowIso();
  markRunUpdated(run);
  return saveWorkflowRunState(run, options.meta);
}

export async function executeWorkflow(
  input: ExecuteWorkflowInput,
): Promise<WorkflowRunState> {
  const workflow = parseWorkflow(input.workflow);
  const run = makeInitialRun({
    workflow,
    runId: input.runId,
    threadId: input.threadId,
    initiatorCoworkerId: input.initiatorCoworkerId,
  });
  saveWorkflowDefinition(workflow, input.meta);
  return continueRun(run, input);
}

export async function resumeWorkflowRun(
  input: ResumeWorkflowInput,
): Promise<WorkflowRunState> {
  const run = getWorkflowRunState(input.runId);
  if (!run) throw new Error(`Unknown workflow run: ${input.runId}`);
  if (run.status === 'completed') return run;
  return continueRun(run, input);
}

export async function approveStep(
  runId: string,
  stepId: string,
  actor: string,
  options: Omit<ResumeWorkflowInput, 'runId' | 'actor'> = {},
): Promise<WorkflowRunState> {
  const run = getWorkflowRunState(runId);
  if (!run) throw new Error(`Unknown workflow run: ${runId}`);
  const stepState = findStepState(run, stepId);
  if (run.status !== 'paused' || run.current_step_id !== stepId) {
    throw new Error(`Workflow run ${runId} is not paused at step ${stepId}`);
  }
  if (stepState.escalation?.route !== 'approval_request') {
    throw new Error(`Workflow step ${stepId} is not waiting for escalation`);
  }

  const approvedAt = nowIso();
  stepState.escalation = {
    ...stepState.escalation,
    approved_at: approvedAt,
    approved_by: actor,
  };
  stepState.status = 'pending';
  run.status = 'running';
  run.events.push(
    event('workflow.step.approved', {
      step_id: stepId,
      actor,
    }),
  );
  recordWorkflowAudit(run, options.sessionId, {
    type: 'workflow.escalation.resolved',
    workflowId: run.workflow.id,
    runId: run.id,
    stepId,
    actor,
    approved: true,
  });
  markRunUpdated(run);
  saveWorkflowRunState(run, options.meta);
  return continueRun(run, options);
}

export async function returnForRevision(
  runId: string,
  stepId: string,
  notes: string,
  options: Omit<ResumeWorkflowInput, 'runId'> & {
    fromStepId?: string;
  } = {},
): Promise<WorkflowRunState> {
  const run = getWorkflowRunState(runId);
  if (!run) throw new Error(`Unknown workflow run: ${runId}`);
  const targetStep = findStep(run.workflow, stepId);
  const targetState = findStepState(run, targetStep.id);
  const fromStepId =
    options.fromStepId ||
    run.current_step_id ||
    run.steps.at(-1)?.step_id ||
    stepId;
  const revision = targetState.revisions.length + 1;
  const createdAt = nowIso();

  targetState.revisions.push({
    revision,
    from_step_id: fromStepId,
    target_step_id: stepId,
    notes,
    ...(options.actor ? { actor: options.actor } : {}),
    created_at: createdAt,
  });
  for (const stepState of run.steps) {
    const workflowIndex = run.workflow.steps.findIndex(
      (step) => step.id === stepState.step_id,
    );
    const targetIndex = run.workflow.steps.findIndex(
      (step) => step.id === stepId,
    );
    if (workflowIndex >= targetIndex) {
      stepState.status =
        stepState.step_id === stepId ? 'pending' : 'revision_requested';
      delete stepState.started_at;
      delete stepState.completed_at;
      delete stepState.paused_at;
      delete stepState.failed_at;
      delete stepState.error;
      delete stepState.escalation;
    }
  }
  targetState.status = 'pending';
  run.status = 'running';
  run.current_step_id = stepId;
  run.events.push(
    event('workflow.step.returned_for_revision', {
      step_id: stepId,
      from_step_id: fromStepId,
      actor: options.actor,
      notes,
    }),
  );
  recordWorkflowAudit(run, options.sessionId, {
    type: 'workflow.revision_requested',
    workflowId: run.workflow.id,
    runId: run.id,
    stepId,
    fromStepId,
    actor: options.actor || null,
    notes,
  });
  markRunUpdated(run);
  saveWorkflowRunState(run, options.meta);
  return continueRun(run, options);
}
