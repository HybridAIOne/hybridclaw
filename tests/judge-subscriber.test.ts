import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { SkillRunEvent } from '../src/skills/skill-run-events.js';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;

let cleanup: Array<() => void> = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-judge-sub-'));
  return path.join(dir, 'test.db');
}

function buildSkillRunEvent(
  overrides: Partial<SkillRunEvent> = {},
): SkillRunEvent {
  return {
    type: 'skill_run',
    skill_id: 'pdf',
    agent_id: 'agent-1',
    session_id: 'session-1',
    run_id: 'run-1',
    created_at: '2026-04-29T00:00:00.000Z',
    input: { content: 'Summarize the PDF.', truncated: false },
    output: { content: 'Summary complete.', truncated: false },
    input_full: null,
    output_full: null,
    model: 'worker-model',
    tokens: {
      prompt: 10,
      completion: 4,
      total: 14,
      modelCalls: 1,
      apiUsageAvailable: true,
      estimatedPrompt: 9,
      estimatedCompletion: 3,
      estimatedTotal: 12,
      apiPrompt: 10,
      apiCompletion: 4,
      apiTotal: 14,
    },
    latency_ms: 35,
    cost_usd: 0.001,
    errors: [],
    outcome: 'success',
    error_category: null,
    error_detail: null,
    tool_executions: [],
    tool_executions_full: [],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.HYBRIDCLAW_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-judge-sub-home-'),
  );
  cleanup = [];
  vi.resetModules();
});

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) {
    dispose();
  }
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = ORIGINAL_DATA_DIR;
  vi.restoreAllMocks();
});

test('registerJudgeSubscriber judges matching skill_run events asynchronously', async () => {
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true, dbPath: createTempDbPath() });
  const { emitSkillRunEvent } = await import(
    '../src/skills/skill-run-events.js'
  );
  const { registerJudgeSubscriber, waitForJudgeSubscribersIdle } = await import(
    '../src/evals/judge-subscriber.js'
  );

  const sink = vi.fn();
  const modelCaller = vi.fn(async () => ({
    content: JSON.stringify({
      score: 1,
      reasoning: 'The skill run met the subscriber criteria.',
      verdict: 'pass',
    }),
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      costUsd: 0.00015,
    },
  }));
  cleanup.push(
    registerJudgeSubscriber({
      id: 'pdf-quality',
      filter: { skillId: 'pdf', outcome: 'success' },
      criteria: (event) => `Pass if ${event.skill_id} produced a summary.`,
      sink,
      budget: { agentId: 'feature:pdf-quality' },
      debounceMs: 10,
      judgeOptions: {
        model: 'judge-json-model',
        modelCaller,
      },
    }),
  );

  emitSkillRunEvent(buildSkillRunEvent({ skill_id: 'xlsx' }));
  emitSkillRunEvent(buildSkillRunEvent());

  expect(modelCaller).not.toHaveBeenCalled();
  expect(sink).not.toHaveBeenCalled();

  await waitForJudgeSubscribersIdle();

  expect(modelCaller).toHaveBeenCalledTimes(1);
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({
      subscriberId: 'pdf-quality',
      criteria: 'Pass if pdf produced a summary.',
      result: {
        score: 1,
        reasoning: 'The skill run met the subscriber criteria.',
        verdict: 'pass',
      },
      event: expect.objectContaining({
        type: 'skill_run',
        skill_id: 'pdf',
        run_id: 'run-1',
      }),
      judgedAt: expect.any(String),
    }),
  );
});

test('registerJudgeSubscriber records judge usage against each subscriber budget', async () => {
  const { initDatabase, listUsageByAgent } = await import(
    '../src/memory/db.js'
  );
  initDatabase({ quiet: true, dbPath: createTempDbPath() });
  const { emitSkillRunEvent } = await import(
    '../src/skills/skill-run-events.js'
  );
  const { registerJudgeSubscriber, waitForJudgeSubscribersIdle } = await import(
    '../src/evals/judge-subscriber.js'
  );

  const makeModelCaller = (costUsd: number) =>
    vi.fn(async () => ({
      content: JSON.stringify({
        score: 0.8,
        reasoning: 'The trace is good enough for this subscriber.',
        verdict: 'pass',
      }),
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        costUsd,
      },
    }));

  cleanup.push(
    registerJudgeSubscriber({
      id: 'feature-a',
      filter: () => true,
      criteria: 'Judge for feature A.',
      sink: vi.fn(),
      budget: { agentId: 'feature:a' },
      debounceMs: 0,
      judgeOptions: {
        model: 'judge-json-model',
        modelCaller: makeModelCaller(0.001),
      },
    }),
  );
  cleanup.push(
    registerJudgeSubscriber({
      id: 'feature-b',
      filter: () => true,
      criteria: 'Judge for feature B.',
      sink: vi.fn(),
      budget: { agentId: 'feature:b' },
      debounceMs: 0,
      judgeOptions: {
        model: 'judge-json-model',
        modelCaller: makeModelCaller(0.002),
      },
    }),
  );

  emitSkillRunEvent(buildSkillRunEvent());
  await waitForJudgeSubscribersIdle();

  const usageByAgent = new Map(
    listUsageByAgent().map((row) => [row.agent_id, row] as const),
  );
  expect(usageByAgent.get('feature:a')).toMatchObject({
    total_input_tokens: 20,
    total_output_tokens: 5,
    total_tokens: 25,
    total_cost_usd: 0.001,
    call_count: 1,
  });
  expect(usageByAgent.get('feature:b')).toMatchObject({
    total_input_tokens: 20,
    total_output_tokens: 5,
    total_tokens: 25,
    total_cost_usd: 0.002,
    call_count: 1,
  });
});
