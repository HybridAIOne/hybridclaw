import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  StakesClassificationInput,
  StakesClassifier,
  StakesScore,
} from '../container/shared/stakes-classifier.js';

function makeRuntimeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-workflow-'));
}

function makeScore(level: 'low' | 'medium' | 'high'): StakesScore {
  return {
    level,
    score: level === 'high' ? 0.9 : level === 'medium' ? 0.5 : 0.1,
    confidence: 0.9,
    classifier: 'test:f8',
    signals: [],
    reasons: [`${level} stakes fixture`],
  };
}

function makeClassifier(
  levelsByStep: Record<string, 'low' | 'medium' | 'high'>,
): StakesClassifier {
  return {
    classify(input: StakesClassificationInput): StakesScore {
      const stepId = String(input.args.step_id || '');
      return makeScore(levelsByStep[stepId] || 'low');
    },
  };
}

async function initRuntimeDatabase(): Promise<void> {
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase();
}

describe('workflow engine', () => {
  let runtimeHome: string;

  beforeEach(() => {
    runtimeHome = makeRuntimeHome();
    process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HYBRIDCLAW_DATA_DIR;
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    vi.resetModules();
  });

  test('parses YAML definitions with stakes thresholds and validates transitions', async () => {
    const { parseWorkflowDefinitionYaml, WORKFLOW_DEFINITION_JSON_SCHEMA } =
      await import('../src/workflow/schema.js');

    const workflow = parseWorkflowDefinitionYaml(`
id: launch_copy
name: Launch copy
steps:
  - id: brief
    owner_agent_id: briefing
    action: Write the brief.
    stakes_threshold: medium
  - id: build
    owner_coworker_id: builder
    action: Build the copy.
transitions:
  - from: brief
    to: build
`);

    expect(workflow.steps[0]).toMatchObject({
      id: 'brief',
      owner_coworker_id: 'briefing',
      stakes_threshold: 'medium',
    });
    expect(WORKFLOW_DEFINITION_JSON_SCHEMA.properties.steps).toBeDefined();
  });

  test('runs brief to build autonomously and pauses review when F8 exceeds the threshold', async () => {
    await initRuntimeDatabase();
    const { executeWorkflow, approveStep } = await import(
      '../src/workflow/executor.js'
    );
    const { renderWorkflowRunState } = await import(
      '../src/workflow/visualizer.js'
    );

    const dispatched: string[] = [];
    const workflow = `
id: brief_build_review_test
name: Brief build review test
steps:
  - id: brief
    owner_coworker_id: briefing
    action: Write internal brief.
    stakes_threshold: medium
  - id: build
    owner_coworker_id: builder
    action: Build internal draft.
    stakes_threshold: medium
  - id: review
    owner_coworker_id: reviewer
    action: Send customer-facing launch copy.
    stakes_threshold: medium
transitions:
  - from: brief
    to: build
  - from: build
    to: review
`;

    const paused = await executeWorkflow({
      workflow,
      runId: 'run_launch_copy',
      stakesClassifier: makeClassifier({
        brief: 'low',
        build: 'medium',
        review: 'high',
      }),
      dispatchStep: ({ step }) => {
        dispatched.push(step.id);
        return { artifact: { stepId: step.id } };
      },
    });

    expect(paused.status).toBe('paused');
    expect(paused.current_step_id).toBe('review');
    expect(dispatched).toEqual(['brief', 'build']);
    expect(renderWorkflowRunState(paused)).toContain('pending approval');

    const completed = await approveStep('run_launch_copy', 'review', 'lead', {
      stakesClassifier: makeClassifier({ review: 'high' }),
      dispatchStep: ({ step }) => {
        dispatched.push(step.id);
        return { artifact: { stepId: step.id } };
      },
    });

    expect(completed.status).toBe('completed');
    expect(dispatched).toEqual(['brief', 'build', 'review']);
    expect(
      completed.events.some((entry) => entry.type === 'workflow.step.escalated'),
    ).toBe(true);
  });

  test('starter-style canonical coworkers dispatch through the default A2A path', async () => {
    await initRuntimeDatabase();
    const { executeWorkflow } = await import('../src/workflow/executor.js');
    const { listA2AThreadEnvelopes } = await import('../src/a2a/store.js');

    const completed = await executeWorkflow({
      workflow: {
        id: 'default_dispatch_test',
        name: 'Default dispatch test',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'briefing@workflow@starter',
            action: 'Write the internal brief.',
          },
          {
            id: 'build',
            owner_coworker_id: 'builder@workflow@starter',
            action: 'Build the internal draft.',
          },
        ],
        transitions: [{ from: 'brief', to: 'build' }],
      },
      runId: 'run_default_dispatch',
      threadId: 'thread_default_dispatch',
    });

    expect(completed.status).toBe('completed');
    expect(completed.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
    ]);
    const envelopes = listA2AThreadEnvelopes('thread_default_dispatch');
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((entry) => entry.recipient_agent_id)).toEqual([
      'briefing@workflow@starter',
      'builder@workflow@starter',
    ]);
  });

  test('service entrypoint registers pending approvals for escalated steps', async () => {
    await initRuntimeDatabase();
    const { getPendingApproval, clearPendingApproval } = await import(
      '../src/gateway/pending-approvals.js'
    );
    const { saveWorkflowDefinition } = await import('../src/workflow/store.js');
    const { startWorkflowRun } = await import('../src/workflow/service.js');

    saveWorkflowDefinition({
      id: 'approval_service_test',
      name: 'Approval service test',
      steps: [
        {
          id: 'brief',
          owner_coworker_id: 'briefing@workflow@starter',
          action: 'Write the internal brief.',
          stakes_threshold: 'medium',
        },
        {
          id: 'review',
          owner_coworker_id: 'reviewer@workflow@starter',
          action: 'Send customer-facing launch copy.',
          stakes_threshold: 'medium',
        },
      ],
      transitions: [{ from: 'brief', to: 'review' }],
    });

    const run = await startWorkflowRun({
      workflowId: 'approval_service_test',
      runId: 'run_pending_approval',
      sessionId: 'session-workflow',
      userId: 'operator',
    });

    expect(run.status).toBe('paused');
    expect(run.current_step_id).toBe('review');
    expect(getPendingApproval('session-workflow')).toMatchObject({
      approvalId: 'workflow:run_pending_approval:review',
      userId: 'operator',
      commandAction: {
        approveArgs: [
          'workflow',
          'approve',
          'run_pending_approval',
          'review',
        ],
      },
    });

    await clearPendingApproval('session-workflow');
  });

  test('returnForRevision rewinds to a named step and preserves prior artifacts', async () => {
    await initRuntimeDatabase();
    const { executeWorkflow, returnForRevision } = await import(
      '../src/workflow/executor.js'
    );

    const dispatched: string[] = [];
    const workflow = {
      id: 'revision_test',
      name: 'Revision test',
      steps: [
        {
          id: 'brief',
          owner_coworker_id: 'briefing',
          action: 'Brief the work.',
        },
        {
          id: 'build',
          owner_coworker_id: 'builder',
          action: 'Build the work.',
        },
      ],
      transitions: [{ from: 'brief', to: 'build' }],
    };

    const completed = await executeWorkflow({
      workflow,
      runId: 'run_revision',
      dispatchStep: ({ step }) => {
        dispatched.push(step.id);
        return { artifact: { pass: dispatched.length, stepId: step.id } };
      },
    });
    expect(completed.status).toBe('completed');

    const revised = await returnForRevision(
      'run_revision',
      'brief',
      'Tighten the source citations.',
      {
        fromStepId: 'build',
        actor: 'reviewer',
        dispatchStep: ({ step }) => {
          dispatched.push(step.id);
          return { artifact: { pass: dispatched.length, stepId: step.id } };
        },
      },
    );

    expect(revised.status).toBe('completed');
    expect(dispatched).toEqual(['brief', 'build', 'brief', 'build']);
    const brief = revised.steps.find((step) => step.step_id === 'brief');
    expect(brief?.artifacts).toHaveLength(2);
    expect(brief?.revisions[0]).toMatchObject({
      from_step_id: 'build',
      notes: 'Tighten the source citations.',
      actor: 'reviewer',
    });
  });
});
