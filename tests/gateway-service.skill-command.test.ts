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

test('skill inspect command reports observed skill health', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'tool_error',
    errorDetail: 'tool failed',
    toolCallsAttempted: 2,
    toolCallsFailed: 1,
    durationMs: 125,
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-skill-inspect',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'inspect', context.skillName],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Skill Health');
  expect(result.text).toContain(`Skill: ${context.skillName}`);
  expect(result.text).toContain('Executions: 1');
  expect(result.text).toContain('Tool breakage: 0.50');
});

test('skill amend and history commands stage and show amendments', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'instructions too vague',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 90,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Clarify the expected steps.',
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

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const staged = await handleGatewayCommand({
    sessionId: 'session-skill-amend',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'amend', context.skillName],
  });

  expect(staged.kind).toBe('info');
  if (staged.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${staged.kind}`);
  }
  expect(staged.title).toBe(`Skill Amendment (${context.skillName})`);
  expect(staged.text).toContain('Status: staged');
  expect(staged.text).toContain('Rationale: Clarify the expected steps.');

  const history = await handleGatewayCommand({
    sessionId: 'session-skill-amend',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'history', context.skillName],
  });

  expect(history.kind).toBe('info');
  if (history.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${history.kind}`);
  }
  expect(history.title).toBe(`Skill History (${context.skillName})`);
  expect(history.text).toContain('Version: 1');
  expect(history.text).toContain('Status: staged');
});

test('skill amend --apply command applies the latest staged amendment', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'instructions too vague',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 90,
  });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Clarify the expected steps.',
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

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  await handleGatewayCommand({
    sessionId: 'session-skill-apply',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'amend', context.skillName],
  });
  const applied = await handleGatewayCommand({
    sessionId: 'session-skill-apply',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'amend', context.skillName, '--apply'],
  });

  expect(applied.kind).toBe('plain');
  expect(applied.text).toContain('Applied staged amendment');
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).toContain(
    'List the requested steps before acting.',
  );
});
