import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { SkillCogneeTestContext } from './helpers/skill-cognee-test-setup.ts';
import { createSkillCogneeTestContext } from './helpers/skill-cognee-test-setup.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

let context: SkillCogneeTestContext | null = null;

afterEach(() => {
  runAgentMock.mockReset();
  context?.cleanup();
  context = null;
});

test('stages and rejects a proposed amendment', async () => {
  context = await createSkillCogneeTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'missed an important step',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 120,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Clarify the execution steps.',
      content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Follow the user's request carefully.
List the requested steps before acting.
Keep the response concise.
`,
    }),
    toolsUsed: [],
  });

  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');
  const { getLatestSkillAmendment } = await import('../src/memory/db.ts');
  const { proposeAmendment, rejectAmendment } = await import(
    '../src/skills/skills-amendment.ts'
  );

  const amendment = await proposeAmendment({
    skillName: context.skillName,
    metrics: inspectSkill(context.skillName),
    agentId: 'main',
  });

  expect(amendment.status).toBe('staged');
  expect(amendment.guard_verdict).toBe('safe');
  expect(amendment.diff_summary).toContain('Changed');

  const latest = getLatestSkillAmendment({ skillName: context.skillName });
  expect(latest?.id).toBe(amendment.id);

  const rejected = rejectAmendment({
    amendmentId: amendment.id,
    reviewedBy: 'test',
  });
  expect(rejected.ok).toBe(true);
  expect(
    getLatestSkillAmendment({ skillName: context.skillName })?.status,
  ).toBe('rejected');
});

test('applyAmendment refuses to overwrite concurrent skill edits', async () => {
  context = await createSkillCogneeTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'ambiguous instructions',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 80,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Add a concrete checklist.',
      content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Follow the user's request carefully.
Use a short checklist before acting.
Keep the response concise.
`,
    }),
    toolsUsed: [],
  });

  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');
  const { proposeAmendment, applyAmendment } = await import(
    '../src/skills/skills-amendment.ts'
  );

  const amendment = await proposeAmendment({
    skillName: context.skillName,
    metrics: inspectSkill(context.skillName),
    agentId: 'main',
  });
  fs.writeFileSync(context.skillFilePath, 'manual edit\n', 'utf-8');

  const applied = await applyAmendment({
    amendmentId: amendment.id,
    reviewedBy: 'test',
  });
  expect(applied.ok).toBe(false);
  expect(applied.reason).toContain('changed since the amendment was proposed');
});
