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

test('stages and rejects a proposed amendment', async () => {
  context = await createAdaptiveSkillsTestContext();
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

  const agentMessages = runAgentMock.mock.calls[0]?.[0]?.messages;
  expect(agentMessages?.[0]?.role).toBe('system');
  expect(agentMessages?.[0]?.content).toContain('## Runtime Metadata');

  expect(amendment.status).toBe('staged');
  expect(amendment.guard_verdict).toBe('safe');
  expect(amendment.diff_summary).toBe('8 line(s) (was 7).');

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

test('accepts amendment proposals wrapped in markdown json fences', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'needs a clearer checklist',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 100,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: `\`\`\`json
${JSON.stringify({
  rationale: 'Clarify the execution steps.',
  content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Follow the user's request carefully.
List the requested steps before acting.
Keep the response concise.
`,
})}
\`\`\``,
    toolsUsed: [],
  });

  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');
  const { proposeAmendment } = await import(
    '../src/skills/skills-amendment.ts'
  );

  const amendment = await proposeAmendment({
    skillName: context.skillName,
    metrics: inspectSkill(context.skillName),
    agentId: 'main',
  });

  expect(amendment.rationale).toBe('Clarify the execution steps.');
  expect(amendment.status).toBe('staged');
});

test('fails clearly when the amendment proposal is not valid json', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'needs a clearer checklist',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 100,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: 'Here is my proposal: not actually JSON.',
    toolsUsed: [],
  });

  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');
  const { proposeAmendment } = await import(
    '../src/skills/skills-amendment.ts'
  );

  await expect(
    proposeAmendment({
      skillName: context.skillName,
      metrics: inspectSkill(context.skillName),
      agentId: 'main',
    }),
  ).rejects.toThrow('Skill amendment proposal did not return valid JSON.');
});

test('applyAmendment refuses to overwrite concurrent skill edits', async () => {
  context = await createAdaptiveSkillsTestContext();
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

test('increments amendment version history for repeated proposals', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'needs clarification',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 90,
  });

  runAgentMock
    .mockResolvedValueOnce({
      status: 'success',
      result: JSON.stringify({
        rationale: 'Clarify the first step.',
        content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Follow the user's request carefully.
Clarify the first step before acting.
Keep the response concise.
`,
      }),
      toolsUsed: [],
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: JSON.stringify({
        rationale: 'Clarify the fallback path.',
        content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Follow the user's request carefully.
Clarify the first step before acting.
Document the fallback path explicitly.
Keep the response concise.
`,
      }),
      toolsUsed: [],
    });

  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');
  const { proposeAmendment } = await import(
    '../src/skills/skills-amendment.ts'
  );

  const first = await proposeAmendment({
    skillName: context.skillName,
    metrics: inspectSkill(context.skillName),
    agentId: 'main',
  });
  const second = await proposeAmendment({
    skillName: context.skillName,
    metrics: inspectSkill(context.skillName),
    agentId: 'main',
  });

  expect(first.version).toBe(1);
  expect(first.previous_version).toBeNull();
  expect(second.version).toBe(2);
  expect(second.previous_version).toBe(1);
});

test('diff summary treats inserted lines as additions instead of wholesale changes', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'opening checklist is missing',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 75,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Add a short opening checklist.',
      content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Start by listing the exact steps you will take.
Follow the user's request carefully.
Keep the response concise.
`,
    }),
    toolsUsed: [],
  });

  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');
  const { proposeAmendment } = await import(
    '../src/skills/skills-amendment.ts'
  );

  const amendment = await proposeAmendment({
    skillName: context.skillName,
    metrics: inspectSkill(context.skillName),
    agentId: 'main',
  });

  expect(amendment.diff_summary).toBe('8 line(s) (was 7).');
});
