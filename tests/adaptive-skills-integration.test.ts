import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { AdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';
import { createAdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

let context: AdaptiveSkillsTestContext | null = null;

afterEach(() => {
  runAgentMock.mockReset();
  context?.cleanup();
  context = null;
});

test('runs the inspection, amendment, apply, and rollback loop end to end', async () => {
  context = await createAdaptiveSkillsTestContext({
    skillBody: `---
name: demo-skill
description: Demo skill for tests
---
Follow the user's request carefully.
Keep the response concise.
`,
  });
  context.runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.enabled = true;
    draft.adaptiveSkills.autoApplyEnabled = true;
    draft.adaptiveSkills.evaluationRunsBeforeRollback = 1;
    draft.adaptiveSkills.rollbackImprovementThreshold = 0.1;
  });

  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'seed-session',
    runId: 'seed-run',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'instructions were too vague',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 100,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Add a checklist to reduce ambiguity.',
      content: `---
name: demo-skill
description: Demo skill for tests
---
Follow the user's request carefully.
List the required steps before acting.
Keep the response concise.
`,
    }),
    toolsUsed: [],
  });

  const { getLatestSkillAmendment } = await import('../src/memory/db.ts');
  const { runPeriodicSkillInspection } = await import(
    '../src/skills/skills-inspection.ts'
  );
  const { recordSkillExecution } = await import(
    '../src/skills/skills-observation.ts'
  );

  await runPeriodicSkillInspection({ agentId: 'main' });

  const applied = getLatestSkillAmendment({
    skillName: context.skillName,
    status: 'applied',
  });
  expect(applied).not.toBeNull();
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).toContain(
    'List the required steps before acting.',
  );

  await recordSkillExecution({
    skillName: context.skillName,
    sessionId: 'post-apply-session',
    runId: 'post-apply-run',
    toolExecutions: [],
    outcome: 'failure',
    durationMs: 90,
    errorCategory: 'model_error',
    errorDetail: 'still failed',
  });

  const rolledBack = getLatestSkillAmendment({
    skillName: context.skillName,
  });
  expect(rolledBack?.status).toBe('rolled_back');
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).toContain(
    "Follow the user's request carefully.",
  );
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).not.toContain(
    'List the required steps before acting.',
  );
});
