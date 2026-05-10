import { expect, test, vi } from 'vitest';

import {
  parseAnomalyTraceJudgeResult,
  resolveBorderlineAnomalyWithTraceJudge,
} from '../container/src/anomaly-trace-judge.js';
import type { ToolApprovalEvaluation } from '../container/src/approval-policy.js';

const BASE_EVALUATION: ToolApprovalEvaluation = {
  baseTier: 'green',
  tier: 'green',
  autonomyLevel: 'full-autonomous',
  stakes: 'low',
  stakesScore: {
    level: 'low',
    score: 0,
    confidence: 1,
    classifier: 'test',
    signals: [],
    reasons: ['test'],
  },
  stakesMiddlewareDecision: { action: 'allow' },
  escalationRoute: 'none',
  decision: 'auto',
  actionKey: 'read',
  fingerprint: 'fp',
  intent: 'read a file',
  consequenceIfDenied: 'I will skip the read.',
  reason: 'this is read-only',
  commandPreview: '{"path":"README.md"}',
  pinned: false,
  hostHints: [],
  anomaly: {
    score: 0.91,
    threshold: 0.9,
    reason:
      'behavior anomaly score is borderline; F11 trace-judge second opinion required before tier elevation',
    status: 'borderline',
    model: 'order2_markov_frequency_v1',
    trajectoryCount: 80,
    tuple: 'read',
  },
};

test('parseAnomalyTraceJudgeResult normalizes F11 JSON output', () => {
  expect(
    parseAnomalyTraceJudgeResult(
      '{"verdict":"anomalous","score":0.87,"reasoning":"rare target for this agent"}',
    ),
  ).toEqual({
    verdict: 'anomalous',
    score: 0.87,
    reason: 'rare target for this agent',
  });
});

test('parseAnomalyTraceJudgeResult falls back when fenced JSON is malformed', () => {
  expect(
    parseAnomalyTraceJudgeResult(`before
\`\`\`json
[bad json
\`\`\`
after {"verdict":"normal","score":0.12,"reason":"embedded fallback"}`),
  ).toEqual({
    verdict: 'normal',
    score: 0.12,
    reason: 'embedded fallback',
  });
});

test('resolveBorderlineAnomalyWithTraceJudge records anomalous F11 verdict for pipeline replay', async () => {
  const caller = vi.fn(async () => ({
    model: 'judge-model',
    content:
      '{"verdict":"anomalous","score":0.82,"reasoning":"unusual target and hour"}',
    response: {
      choices: [{ message: { role: 'assistant', content: '{}' } }],
    },
  }));

  const resolved = await resolveBorderlineAnomalyWithTraceJudge({
    evaluation: BASE_EVALUATION,
    toolName: 'read',
    argsJson: '{"path":"README.md"}',
    latestUserPrompt: 'Read the README',
    fallbackContext: {
      provider: 'hybridai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-5-nano',
      chatbotId: 'bot',
    },
    caller,
  });

  expect(caller).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'eval_judge',
      toolName: 'f11_trace_judge',
      maxTokens: 300,
    }),
  );
  expect(resolved.evaluation.tier).toBe('green');
  expect(resolved.evaluation.baseTier).toBe('green');
  expect(resolved.evaluation.anomaly?.traceJudge).toEqual({
    verdict: 'anomalous',
    score: 0.82,
    reason: 'unusual target and hour',
  });
});

test('resolveBorderlineAnomalyWithTraceJudge keeps tier when F11 marks score normal', async () => {
  const caller = vi.fn(async () => ({
    model: 'judge-model',
    content:
      '{"verdict":"normal","score":0.22,"reasoning":"consistent with user prompt"}',
    response: {
      choices: [{ message: { role: 'assistant', content: '{}' } }],
    },
  }));

  const resolved = await resolveBorderlineAnomalyWithTraceJudge({
    evaluation: BASE_EVALUATION,
    toolName: 'read',
    argsJson: '{"path":"README.md"}',
    latestUserPrompt: 'Read the README',
    fallbackContext: {
      provider: 'hybridai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-5-nano',
      chatbotId: 'bot',
    },
    caller,
  });

  expect(resolved.evaluation.tier).toBe('green');
  expect(resolved.evaluation.anomaly?.traceJudge?.verdict).toBe('normal');
});

test('resolveBorderlineAnomalyWithTraceJudge redacts sensitive tool arguments before F11', async () => {
  const caller = vi.fn(async () => ({
    model: 'judge-model',
    content:
      '{"verdict":"normal","score":0.22,"reasoning":"consistent with prompt"}',
    response: {
      choices: [{ message: { role: 'assistant', content: '{}' } }],
    },
  }));

  await resolveBorderlineAnomalyWithTraceJudge({
    evaluation: BASE_EVALUATION,
    toolName: 'browser_type',
    argsJson: JSON.stringify({
      text: 'my secret form entry',
      password: 'hunter2',
      nested: {
        api_key: 'sk-test',
        keep: 'visible',
      },
    }),
    latestUserPrompt: 'Fill in the login form',
    fallbackContext: {
      provider: 'hybridai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-5-nano',
      chatbotId: 'bot',
    },
    caller,
  });

  const messages = caller.mock.calls[0]?.[0].messages;
  const userContent = JSON.parse(String(messages?.[1]?.content)) as {
    argsJson: string;
  };
  const args = JSON.parse(userContent.argsJson) as Record<string, unknown>;

  expect(args).toMatchObject({
    text: '[REDACTED]',
    password: '[REDACTED]',
    nested: {
      api_key: '[REDACTED]',
      keep: 'visible',
    },
  });
});
