import { describe, expect, test } from 'vitest';

import {
  classifyStakes,
  createStakesClassifier,
  type StakesClassificationInput,
  type StakesClassifier,
  type StakesLevel,
} from '../container/src/stakes-classifier.js';

interface StakesEvalExample {
  label: string;
  expected: StakesLevel;
  input: StakesClassificationInput;
}

function makeInput(
  overrides: Partial<StakesClassificationInput>,
): StakesClassificationInput {
  return {
    toolName: 'read',
    args: {},
    actionKey: 'read',
    intent: 'run read',
    reason: 'this is a read-only operation',
    target: 'README.md',
    approvalTier: 'green',
    pathHints: [],
    hostHints: [],
    writeIntent: false,
    pinned: false,
    ...overrides,
  };
}

const lowTools = [
  'read',
  'glob',
  'grep',
  'session_search',
  'vision_analyze',
  'image',
  'delegate',
  'tavily__search',
];
const mediumActions = [
  {
    toolName: 'write',
    actionKey: 'write:src',
    intent: 'write project file',
    target: 'src/module.ts',
    writeIntent: true,
  },
  {
    toolName: 'edit',
    actionKey: 'edit:docs',
    intent: 'edit project docs',
    target: 'docs/guide.md',
    writeIntent: true,
  },
  {
    toolName: 'bash',
    actionKey: 'bash:install-deps',
    intent: 'install dependencies',
    target: 'npm install',
    writeIntent: true,
  },
  {
    toolName: 'web_fetch',
    actionKey: 'network:example.org',
    intent: 'access example.org',
    target: 'https://example.org/reference',
    hostHints: ['example.org'],
    writeIntent: false,
  },
  {
    toolName: 'browser_type',
    actionKey: 'browser_type',
    intent: 'type into a browser field',
    target: 'search box',
    writeIntent: false,
  },
  {
    toolName: 'memory',
    actionKey: 'memory',
    intent: 'update durable memory',
    target: 'memory preference',
    writeIntent: true,
  },
  {
    toolName: 'cron',
    actionKey: 'cron:add',
    intent: 'schedule an internal reminder',
    target: 'reminder for local status review',
    writeIntent: true,
  },
];
const highActions = [
  {
    toolName: 'delete',
    actionKey: 'delete:dist',
    intent: 'delete dist',
    target: 'delete dist',
    args: { path: 'dist' },
    approvalTier: 'red' as const,
    writeIntent: true,
  },
  {
    toolName: 'bash',
    actionKey: 'bash:critical',
    intent: 'run critical command',
    target: 'sudo chmod 777 /etc/hosts',
    args: { command: 'sudo chmod 777 /etc/hosts' },
    approvalTier: 'red' as const,
    writeIntent: true,
    pinned: true,
  },
  {
    toolName: 'bash',
    actionKey: 'bash:deploy',
    intent: 'deploy production release',
    target: 'deploy to production',
    args: { environment: 'production' },
    approvalTier: 'yellow' as const,
    writeIntent: true,
  },
  {
    toolName: 'message',
    actionKey: 'message:send',
    intent: 'send customer update',
    target: 'customer-success channel',
    args: { action: 'send', text: 'Email the customer about the refund' },
    approvalTier: 'yellow' as const,
    writeIntent: true,
  },
  {
    toolName: 'http_request',
    actionKey: 'billing:charge',
    intent: 'charge customer card',
    target: 'billing API charge',
    args: { amount: 'EUR 750', customerId: 'customer-123' },
    approvalTier: 'yellow' as const,
    writeIntent: true,
  },
  {
    toolName: 'write',
    actionKey: 'write:env',
    intent: 'write .env',
    target: '.env',
    args: { path: '.env', contents: 'API_KEY=test-key' },
    approvalTier: 'red' as const,
    writeIntent: true,
    pinned: true,
  },
  {
    toolName: 'mcp__stripe__refund',
    actionKey: 'mcp:stripe:execute',
    intent: 'issue refund',
    target: 'refund invoice',
    args: { amount: '€650', invoice: 'invoice_123' },
    approvalTier: 'red' as const,
    writeIntent: true,
  },
];

const evalExamples: StakesEvalExample[] = [
  ...Array.from({ length: 80 }, (_, index) => {
    const toolName = lowTools[index % lowTools.length];
    return {
      label: `low-${toolName}-${index}`,
      expected: 'low' as const,
      input: makeInput({
        toolName,
        actionKey: toolName.includes('__') ? 'mcp:search:search' : toolName,
        intent: `run ${toolName}`,
        target: `internal/reference-${index}.md`,
        args: { path: `internal/reference-${index}.md` },
      }),
    };
  }),
  ...Array.from({ length: 70 }, (_, index) => {
    const action = mediumActions[index % mediumActions.length];
    return {
      label: `medium-${action.toolName}-${index}`,
      expected: 'medium' as const,
      input: makeInput({
        ...action,
        args: {
          path: `workspace/file-${index}.md`,
          note: 'internal project state only',
        },
        approvalTier: 'yellow',
      }),
    };
  }),
  ...Array.from({ length: 70 }, (_, index) => {
    const action = highActions[index % highActions.length];
    return {
      label: `high-${action.toolName}-${index}`,
      expected: 'high' as const,
      input: makeInput({
        ...action,
        args: {
          ...action.args,
          sequence: index,
        },
      }),
    };
  }),
];

describe('stakes classifier', () => {
  test('eval suite covers at least 200 labeled examples across action classes', () => {
    expect(evalExamples).toHaveLength(220);
    expect(new Set(evalExamples.map((example) => example.expected))).toEqual(
      new Set(['low', 'medium', 'high']),
    );

    const mismatches = evalExamples
      .map((example) => ({
        label: example.label,
        expected: example.expected,
        actual: classifyStakes(example.input).level,
      }))
      .filter((result) => result.actual !== result.expected);

    expect(mismatches).toEqual([]);
  });

  test('rule classifier reports structured scoring signals', () => {
    const result = classifyStakes(
      makeInput({
        toolName: 'http_request',
        actionKey: 'billing:charge',
        intent: 'charge customer card',
        target: 'billing API charge',
        args: { amount: '€900', customer: 'customer-123' },
        approvalTier: 'yellow',
        writeIntent: true,
      }),
    );

    expect(result.level).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.classifier).toBe('rules:v1');
    expect(result.signals.map((signal) => signal.name)).toContain('cost:high');
    expect(result.reasons).toContain('detected cost exposure >= EUR 500');
  });

  test('optional ML classifier can raise stakes but cannot lower rule safety', () => {
    const raiseMl: StakesClassifier = {
      classify: () => ({
        level: 'high',
        score: 0.9,
        confidence: 0.9,
        classifier: 'ml:test',
        signals: [
          {
            name: 'ml:semantic-risk',
            level: 'high',
            score: 0.9,
            reason: 'ML classifier identified semantic risk',
          },
        ],
        reasons: ['ML classifier identified semantic risk'],
      }),
    };
    const loweringMl: StakesClassifier = {
      classify: () => ({
        level: 'low',
        score: 0.05,
        confidence: 0.99,
        classifier: 'ml:test',
        signals: [],
        reasons: ['ML classifier considered it low risk'],
      }),
    };

    const raised = createStakesClassifier({ mlClassifier: raiseMl }).classify(
      makeInput({ toolName: 'read', actionKey: 'read' }),
    );
    expect(raised?.level).toBe('high');
    expect(raised?.classifier).toBe('rules:v1+ml:test');

    const preserved = createStakesClassifier({
      mlClassifier: loweringMl,
    }).classify(
      makeInput({
        toolName: 'delete',
        actionKey: 'delete:workspace',
        intent: 'delete workspace',
        target: 'delete workspace',
        approvalTier: 'red',
        writeIntent: true,
      }),
    );
    expect(preserved?.level).toBe('high');
  });
});
