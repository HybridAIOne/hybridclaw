import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SkillRunEvent } from '../src/skills/skill-run-events.js';

const mocks = vi.hoisted(() => ({
  callAuxiliaryModel: vi.fn(),
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
  workspaceDir: '',
}));

vi.mock('../src/agents/agent-registry.js', () => ({
  displayNameForAgent: vi.fn(() => 'Main Agent'),
  getAgentById: vi.fn(() => ({ id: 'main', name: 'Main Agent' })),
}));

vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: vi.fn(() => ({
    adaptiveSkills: {
      cv: {
        batchDebounceMs: 30_000,
        narrationDailyBudgetUsd: 0.005,
        renderThrottleMs: 0,
        retentionDays: 90,
      },
    },
    auxiliaryModels: {
      cv_narration: {
        provider: 'auto',
        model: '',
      },
    },
  })),
}));

vi.mock('../src/infra/ipc.js', () => ({
  agentWorkspaceDir: vi.fn(() => mocks.workspaceDir),
}));

vi.mock('../src/logger.js', () => ({
  logger: mocks.logger,
}));

vi.mock('../src/memory/db.js', () => ({
  getWeeklyAgentAnomalyRollups: vi.fn(() => []),
}));

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: mocks.callAuxiliaryModel,
}));

vi.mock('../src/providers/model-catalog.js', () => ({
  findCheapestModelMeetingCapabilities: vi.fn(() => 'openrouter/test-cheap'),
  getModelCatalogMetadata: vi.fn(() => ({
    pricingUsdPerToken: {
      input: 0.00000001,
      output: 0.00000001,
    },
  })),
}));

vi.mock('../src/providers/task-routing.js', () => ({
  isAuxiliaryTaskDisabled: vi.fn(() => false),
  normalizeAuxiliaryProviderModel: vi.fn(
    ({ provider, model }: { provider: string; model: string }) =>
      `${provider}/${model}`,
  ),
}));

vi.mock('../src/security/confidential-runtime.js', () => ({
  getConfidentialRuleSet: vi.fn(() => null),
  isConfidentialRedactionEnabled: vi.fn(() => false),
}));

const {
  scheduleAgentCvRefresh,
  waitForQueuedAgentCvRefreshes,
  cvPathForAgent,
} = await import('../src/skills/agent-cv.js');

function buildSkillRunEvent(): SkillRunEvent {
  return {
    type: 'skill_run',
    skill_id: 'demo-skill',
    agent_id: 'main',
    session_id: 'session-1',
    run_id: 'run-1',
    created_at: '2026-05-15T07:59:30.000Z',
    input: { content: 'Use demo-skill.', truncated: false },
    output: { content: 'Done.', truncated: false },
    input_full: null,
    output_full: null,
    model: null,
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
    latency_ms: 1234,
    cost_usd: 0,
    errors: [],
    outcome: 'success',
    error_category: null,
    error_detail: null,
    tool_executions: [],
    tool_executions_full: [],
  };
}

beforeEach(() => {
  mocks.workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cv-'));
  mocks.callAuxiliaryModel.mockReset();
  mocks.logger.debug.mockReset();
  mocks.logger.warn.mockReset();
});

afterEach(async () => {
  await waitForQueuedAgentCvRefreshes();
  fs.rmSync(mocks.workspaceDir, { recursive: true, force: true });
});

test('does not write deterministic CV entries when auxiliary narration fails', async () => {
  mocks.callAuxiliaryModel.mockRejectedValueOnce(
    new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    ),
  );

  expect(
    scheduleAgentCvRefresh('main', {
      delayMs: 0,
      event: buildSkillRunEvent(),
    }),
  ).toBe(true);
  await waitForQueuedAgentCvRefreshes();

  expect(fs.existsSync(cvPathForAgent('main'))).toBe(false);
  expect(mocks.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      eventCount: 1,
      error: expect.any(DOMException),
    }),
    'Failed to narrate agent CV entries',
  );
});

test('writes only auxiliary-narrated CV entries', async () => {
  mocks.callAuxiliaryModel.mockResolvedValueOnce({
    provider: 'openrouter',
    model: 'openrouter/test-cheap',
    content: JSON.stringify([
      {
        run_id: 'run-1',
        title: 'Handled Demo Skill',
        description: 'Used the demo skill and completed the requested work.',
      },
    ]),
  });

  expect(
    scheduleAgentCvRefresh('main', {
      delayMs: 0,
      event: buildSkillRunEvent(),
    }),
  ).toBe(true);
  await waitForQueuedAgentCvRefreshes();

  const cv = fs.readFileSync(cvPathForAgent('main'), 'utf-8');
  expect(cv).toContain('Handled Demo Skill');
  expect(cv).toContain('Used the demo skill and completed the requested work.');
  expect(cv).not.toContain('Completed demo-skill in 1.2s.');
  expect(mocks.callAuxiliaryModel).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'cv_narration',
      timeoutMs: 45_000,
    }),
  );
});
