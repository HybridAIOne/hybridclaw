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
    delete process.env.HYBRIDCLAW_WORKFLOW_APPROVAL_TTL_MS;
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
    expect(() =>
      parseWorkflowDefinitionYaml(`
id: branching
name: Branching
steps:
  - id: brief
    owner_coworker_id: briefing
    action: Write the brief.
  - id: build
    owner_coworker_id: builder
    action: Build the draft.
  - id: review
    owner_coworker_id: reviewer
    action: Review the draft.
transitions:
  - from: brief
    to: build
  - from: brief
    to: review
`),
    ).toThrow('multiple outgoing transitions');
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

  test('default workflow stakes classifier caches repeated action classifications', async () => {
    const { createWorkflowStakesClassifier } = await import(
      '../src/workflow/stakes-classifier.js'
    );

    const classifier = createWorkflowStakesClassifier();
    const input: StakesClassificationInput = {
      toolName: 'workflow_step',
      args: {
        workflow_id: 'cache_test',
        step_id: 'review',
        action: 'Review customer-facing copy.',
        owner_coworker_id: 'reviewer',
      },
      actionKey: 'workflow:cache_test:review',
      intent: 'Review customer-facing copy.',
      reason: 'workflow step dispatch',
      target: 'Review customer-facing copy.',
      approvalTier: 'green',
      pathHints: [],
      hostHints: [],
      writeIntent: true,
      pinned: false,
    };

    const first = classifier.classify(input);
    const second = classifier.classify(input);

    expect(second).toBe(first);
  });

  test('rejects workflows without a root step', async () => {
    await initRuntimeDatabase();
    const { executeWorkflow } = await import('../src/workflow/executor.js');

    await expect(
      executeWorkflow({
        workflow: {
          id: 'cyclic_workflow',
          name: 'Cyclic workflow',
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
          transitions: [
            { from: 'brief', to: 'build' },
            { from: 'build', to: 'brief' },
          ],
        },
      }),
    ).rejects.toThrow('has no root step');
  });

  test('workflow list helpers skip invalid persisted entries', async () => {
    await initRuntimeDatabase();
    const { syncRuntimeAssetRevisionState } = await import(
      '../src/config/runtime-config-revisions.js'
    );
    const {
      getWorkflowRunState,
      listWorkflowDefinitions,
      listWorkflowRunStates,
      saveWorkflowDefinition,
      workflowDefinitionAssetPath,
      workflowRunAssetPath,
    } = await import('../src/workflow/store.js');
    const { executeWorkflow } = await import('../src/workflow/executor.js');

    saveWorkflowDefinition({
      id: 'valid_definition',
      name: 'Valid definition',
      steps: [
        {
          id: 'brief',
          owner_coworker_id: 'briefing',
          action: 'Brief the work.',
        },
      ],
      transitions: [],
    });
    syncRuntimeAssetRevisionState(
      'workflow',
      workflowDefinitionAssetPath('bad_definition'),
      { route: 'test', source: 'workflow-engine.test' },
      { exists: true, content: '{not-json' },
    );

    const completed = await executeWorkflow({
      workflow: {
        id: 'valid_run_definition',
        name: 'Valid run definition',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'briefing',
            action: 'Brief the work.',
          },
        ],
        transitions: [],
      },
      runId: 'valid_run',
      dispatchStep: ({ step }) => ({ artifact: { stepId: step.id } }),
    });
    syncRuntimeAssetRevisionState(
      'workflow',
      workflowRunAssetPath('bad_status_run'),
      { route: 'test', source: 'workflow-engine.test' },
      {
        exists: true,
        content: `${JSON.stringify(
          {
            ...completed,
            id: 'bad_status_run',
            status: 'future_status',
          },
          null,
          2,
        )}\n`,
      },
    );
    syncRuntimeAssetRevisionState(
      'workflow',
      workflowRunAssetPath('injected_event_run'),
      { route: 'test', source: 'workflow-engine.test' },
      {
        exists: true,
        content: `${JSON.stringify(
          {
            ...completed,
            id: 'injected_event_run',
            events: [
              {
                type: 'workflow.custom',
                actor: 'operator',
                injected: 'untrusted',
                created_at: completed.created_at,
              },
            ],
          },
          null,
          2,
        )}\n`,
      },
    );

    expect(() => getWorkflowRunState('bad_status_run')).toThrow(
      'workflow run status is invalid',
    );
    const sanitizedRun = getWorkflowRunState('injected_event_run');
    expect(sanitizedRun?.events[0]).toMatchObject({
      type: 'workflow.custom',
      actor: 'operator',
    });
    expect(Object.hasOwn(sanitizedRun?.events[0] || {}, 'injected')).toBe(
      false,
    );
    expect(listWorkflowDefinitions().map((definition) => definition.id)).toEqual(
      ['valid_definition', 'valid_run_definition'],
    );
    const runIds = listWorkflowRunStates().map((run) => run.id);
    expect(runIds).toEqual(expect.arrayContaining(['valid_run']));
    expect(runIds).not.toContain('bad_status_run');
  });

  test('service entrypoint registers pending approvals for escalated steps', async () => {
    await initRuntimeDatabase();
    const { getPendingApproval, clearPendingApproval } = await import(
      '../src/gateway/pending-approvals.js'
    );
    const { saveWorkflowDefinition } = await import('../src/workflow/store.js');
    const { startWorkflowRun } = await import('../src/workflow/service.js');

    process.env.HYBRIDCLAW_WORKFLOW_APPROVAL_TTL_MS = '7200000';
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
    await expect(
      startWorkflowRun({
        workflowId: 'approval_service_test',
        runId: 'run_missing_actor',
        sessionId: 'session-workflow',
        userId: '',
      }),
    ).rejects.toThrow('requires an explicit user id');

    const beforeStart = Date.now();
    const run = await startWorkflowRun({
      workflowId: 'approval_service_test',
      runId: 'run_pending_approval',
      sessionId: 'session-workflow',
      userId: 'operator',
    });

    expect(run.status).toBe('paused');
    expect(run.current_step_id).toBe('review');
    const pending = getPendingApproval('session-workflow');
    expect(pending).toMatchObject({
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
    expect((pending?.expiresAt || 0) - beforeStart).toBeGreaterThan(7_100_000);

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

  test('returnForRevision marks downstream steps revision_requested before rerun', async () => {
    await initRuntimeDatabase();
    const { executeWorkflow, returnForRevision } = await import(
      '../src/workflow/executor.js'
    );

    const workflow = {
      id: 'revision_pause_test',
      name: 'Revision pause test',
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
          stakes_threshold: 'medium' as const,
        },
        {
          id: 'review',
          owner_coworker_id: 'reviewer',
          action: 'Review the work.',
        },
      ],
      transitions: [
        { from: 'brief', to: 'build' },
        { from: 'build', to: 'review' },
      ],
    };

    const completed = await executeWorkflow({
      workflow,
      runId: 'run_revision_pause',
      stakesClassifier: makeClassifier({ build: 'low' }),
      dispatchStep: ({ step }) => ({ artifact: { stepId: step.id } }),
    });
    expect(completed.status).toBe('completed');

    const paused = await returnForRevision(
      'run_revision_pause',
      'build',
      'Rework the implementation.',
      {
        fromStepId: 'review',
        stakesClassifier: makeClassifier({ build: 'high' }),
        dispatchStep: ({ step }) => ({ artifact: { stepId: step.id } }),
      },
    );

    expect(paused.status).toBe('paused');
    expect(paused.current_step_id).toBe('build');
    expect(paused.steps.find((step) => step.step_id === 'build')?.status).toBe(
      'paused',
    );
    expect(paused.steps.find((step) => step.step_id === 'review')?.status).toBe(
      'revision_requested',
    );
  });
});
