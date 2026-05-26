import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  applySkillOptLiteEdits,
  gateSkillOptLiteCandidate,
  normalizeSkillOptLiteEdits,
  rankAndClipSkillOptLiteEdits,
} from '../src/skills/skillopt-lite.ts';
import type { AdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';
import { createAdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';

let context: AdaptiveSkillsTestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

test('normalizes ranks clips and applies SkillOpt-lite edits', () => {
  const edits = normalizeSkillOptLiteEdits([
    {
      op: 'append',
      content: '## Edge Cases\n- Verify totals before final output.',
      rationale: 'Recurring arithmetic misses.',
      source_type: 'failure',
      support_count: 3,
    },
    {
      op: 'replace',
      target: 'Keep the response concise.',
      content: 'Keep the response concise and cite any uncertainty.',
      rationale: 'Successful responses included uncertainty.',
      source_type: 'failure',
      support_count: 2,
    },
    {
      op: 'delete',
      target: 'missing target',
      rationale: 'Invalid target should be skipped when selected.',
      source_type: 'failure',
      support_count: 1,
    },
  ]);

  const selected = rankAndClipSkillOptLiteEdits(edits, 2);
  expect(selected).toHaveLength(2);
  expect(selected[0]?.source_type).toBe('failure');

  const applied = applySkillOptLiteEdits(
    'Follow the user request.\nKeep the response concise.\n',
    selected,
  );
  expect(applied.content).toContain('Verify totals before final output.');
  expect(applied.content).toContain(
    'Keep the response concise and cite any uncertainty.',
  );
  expect(applied.report.map((entry) => entry.status)).toEqual([
    'applied_append',
    'applied_replace',
  ]);

  expect(
    gateSkillOptLiteCandidate({
      originalContent: 'a',
      proposedContent: applied.content,
      applyReport: applied.report,
    }),
  ).toMatchObject({ accepted: true });
});

test('records target misses in the SkillOpt-lite apply report', () => {
  const edits = normalizeSkillOptLiteEdits([
    {
      op: 'replace',
      target: 'missing target',
      content: 'replacement',
      rationale: 'Exercise apply reporting for invalid patches.',
      source_type: 'failure',
      support_count: 1,
    },
  ]);

  const applied = applySkillOptLiteEdits('Existing skill text.\n', edits);

  expect(applied.content).toBe('Existing skill text.\n');
  expect(applied.report).toMatchObject([
    {
      op: 'replace',
      target: 'missing target',
      status: 'skipped_target_not_found',
    },
  ]);
  expect(
    gateSkillOptLiteCandidate({
      originalContent: 'Existing skill text.\n',
      proposedContent: applied.content,
      applyReport: applied.report,
    }),
  ).toMatchObject({
    accepted: false,
    reason: 'Candidate does not change the skill document.',
  });
});

test('SkillOpt-lite gate rejects no-op candidates', () => {
  expect(
    gateSkillOptLiteCandidate({
      originalContent: 'same',
      proposedContent: 'same',
      applyReport: [],
    }),
  ).toMatchObject({
    accepted: false,
    reason: 'Candidate does not change the skill document.',
  });
});

test('SkillOpt-lite gate rejects optimizer validation failures', () => {
  expect(
    gateSkillOptLiteCandidate({
      originalContent: 'before',
      proposedContent: 'after',
      applyReport: [
        {
          index: 1,
          op: 'append',
          target: '',
          content_preview: 'after',
          source_type: 'failure',
          support_count: 1,
          status: 'applied_append',
        },
      ],
      validationDecision: {
        action: 'reject',
        reason: 'Held-out examples regressed.',
      },
    }),
  ).toMatchObject({
    accepted: false,
    reason: 'Held-out examples regressed.',
  });
});

test('samples stored skill trajectories by skill agent and newest-first limit', async () => {
  context = await createAdaptiveSkillsTestContext();
  const storeDir = path.join(context.homeDir, 'trajectory-sampler');
  context.runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.trajectoryCapture.storeDir = storeDir;
  });

  const {
    buildSkillRunTrajectoryRecord,
    getSkillRunTrajectories,
    skillRunTrajectoryFilePath,
  } = await import('../src/skills/skill-run-trajectories.ts');

  const baseEvent = {
    type: 'skill_run' as const,
    skill_id: context.skillName,
    agent_id: 'agent-1',
    session_id: 'session-trajectory-sampler',
    run_id: 'run-old',
    created_at: '2026-05-24T00:00:00.000Z',
    input: { content: 'old input', truncated: false },
    output: { content: 'old output', truncated: false },
    input_full: null,
    output_full: null,
    model: 'test-model',
    tokens: {
      prompt: 0,
      completion: 0,
      total: 0,
      modelCalls: 0,
      apiUsageAvailable: false,
      estimatedPrompt: 0,
      estimatedCompletion: 0,
      estimatedTotal: 0,
      apiPrompt: 0,
      apiCompletion: 0,
      apiTotal: 0,
    },
    latency_ms: 10,
    cost_usd: 0,
    errors: [],
    outcome: 'failure' as const,
    error_category: 'model_error' as const,
    error_detail: 'old failure',
    tool_executions: [],
    tool_executions_full: [],
  };
  const records = [
    buildSkillRunTrajectoryRecord(
      baseEvent,
      new Date('2026-05-24T00:00:00.000Z'),
    ),
    buildSkillRunTrajectoryRecord(
      {
        ...baseEvent,
        run_id: 'run-new',
        input: { content: 'new input', truncated: false },
      },
      new Date('2026-05-25T00:00:00.000Z'),
    ),
    buildSkillRunTrajectoryRecord(
      {
        ...baseEvent,
        skill_id: 'other-skill',
        run_id: 'run-other',
      },
      new Date('2026-05-26T00:00:00.000Z'),
    ),
  ];

  for (const record of records) {
    const filePath = skillRunTrajectoryFilePath({
      storeDir,
      date: record.date,
      agentId: record.agent_id,
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  const sampled = getSkillRunTrajectories({
    skillName: context.skillName,
    agentId: 'agent-1',
    limit: 1,
    config: context.runtimeConfigModule.getRuntimeConfig(),
  });

  expect(sampled.map((record) => record.run_id)).toEqual(['run-new']);
  expect(sampled[0]?.input?.content).toBe('new input');
});
