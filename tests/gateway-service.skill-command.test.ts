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
  vi.doUnmock('../src/skills/skills-import.js');
  vi.resetModules();
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
  expect(result.text).toContain('Success rate: 0.00%');
  expect(result.text).toContain('Tool breakage: 50.00%');
});

test('skill runs command reports recent execution observations', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-runs',
    runId: 'run-runs',
    outcome: 'partial',
    errorCategory: 'tool_error',
    errorDetail: 'approval denied',
    toolCallsAttempted: 3,
    toolCallsFailed: 1,
    durationMs: 250,
  });
  context.dbModule.attachFeedbackToObservation({
    sessionId: 'session-runs',
    feedback: 'Needs retry',
    sentiment: 'negative',
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-skill-runs',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'runs', context.skillName],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe(`Skill Runs (${context.skillName})`);
  expect(result.text).toContain('Run: run-runs');
  expect(result.text).toContain('Outcome: partial');
  expect(result.text).toContain('Tools: 1/3 failed');
  expect(result.text).toContain('Feedback: negative');
  expect(result.text).toContain('Error detail: approval denied');
});

test('skill learn and history commands stage and show amendments', async () => {
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
    args: ['skill', 'learn', context.skillName],
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

test('skill learn --apply command applies the latest staged amendment', async () => {
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
    args: ['skill', 'learn', context.skillName],
  });
  const applied = await handleGatewayCommand({
    sessionId: 'session-skill-apply',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'learn', context.skillName, '--apply'],
  });

  expect(applied.kind).toBe('plain');
  expect(applied.text).toContain('Applied staged amendment');
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).toContain(
    'List the requested steps before acting.',
  );
});

test('skill amend is rejected after the rename to learn', async () => {
  context = await createAdaptiveSkillsTestContext();

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-skill-learn-rename',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'amend', context.skillName],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Usage');
  expect(result.text).toContain('skill list|inspect');
  expect(result.text).not.toContain('skill amend');
});

test('skill import imports a community skill through the gateway command path', async () => {
  context = await createAdaptiveSkillsTestContext();

  const importSkillMock = vi.fn().mockResolvedValue({
    skillName: 'brand-guidelines',
    skillDir: '/tmp/.hybridclaw/skills/brand-guidelines',
    source: 'anthropics/skills/skills/brand-guidelines',
    resolvedSource:
      'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines',
    replacedExisting: false,
    filesImported: 2,
  });
  vi.doMock('../src/skills/skills-import.js', () => ({
    importSkill: importSkillMock,
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-skill-import',
    guildId: null,
    channelId: 'web',
    args: ['skill', 'import', 'anthropics/skills/skills/brand-guidelines'],
  });

  expect(importSkillMock).toHaveBeenCalledWith(
    'anthropics/skills/skills/brand-guidelines',
    { force: false },
  );
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Skill Import');
  expect(result.text).toContain(
    'Imported brand-guidelines from https://github.com/anthropics/skills/tree/main/skills/brand-guidelines',
  );
  expect(result.text).toContain(
    'Installed to /tmp/.hybridclaw/skills/brand-guidelines',
  );
});

test('skill import forwards --force and reports caution overrides', async () => {
  context = await createAdaptiveSkillsTestContext();

  const importSkillMock = vi.fn().mockResolvedValue({
    skillName: 'pdf',
    skillDir: '/tmp/.hybridclaw/skills/pdf',
    source: 'claude-marketplace/pdf@anthropic-agent-skills',
    resolvedSource: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    replacedExisting: false,
    filesImported: 1,
    guardOverrideApplied: true,
    guardVerdict: 'caution',
    guardFindingsCount: 1,
  });
  vi.doMock('../src/skills/skills-import.js', () => ({
    importSkill: importSkillMock,
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-skill-import-force',
    guildId: null,
    channelId: 'web',
    args: [
      'skill',
      'import',
      '--force',
      'claude-marketplace/pdf@anthropic-agent-skills',
    ],
  });

  expect(importSkillMock).toHaveBeenCalledWith(
    'claude-marketplace/pdf@anthropic-agent-skills',
    { force: true },
  );
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'Security scanner reported caution findings for pdf (1 finding); proceeding because --force was set.',
  );
});
