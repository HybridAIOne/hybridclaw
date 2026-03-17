import { expect, test } from 'vitest';

import {
  renderWorkflowSpecYaml,
  validateWorkflowSpec,
} from '../../../src/workflow/types.js';

test('upgrades legacy v1 workflow specs to canonical v2 agent steps', () => {
  const validation = validateWorkflowSpec({
    version: 1,
    trigger: {
      kind: 'schedule',
      cronExpr: '0 9 * * *',
    },
    steps: [
      {
        id: 'summarize',
        prompt: 'Summarize my recent Discord messages.',
      },
    ],
    delivery: {
      kind: 'email',
      target: 'me@example.com',
    },
  });

  expect(validation.ok).toBe(true);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  expect(validation.spec).toMatchObject({
    version: 2,
    trigger: {
      kind: 'schedule',
      cronExpr: '0 9 * * *',
    },
    steps: [
      {
        id: 'summarize',
        kind: 'agent',
        prompt: 'Summarize my recent Discord messages.',
      },
    ],
    delivery: {
      kind: 'email',
      target: 'me@example.com',
    },
  });
});

test('renders canonical yaml for v2 workflow defaults and step execution policy', () => {
  const validation = validateWorkflowSpec({
    version: 2,
    trigger: {
      kind: 'schedule',
      cronExpr: '0 9 * * *',
    },
    defaults: {
      timeoutMs: 30000,
      lightContext: true,
      retryPolicy: {
        maxAttempts: 3,
        backoffMs: 5000,
        strategy: 'exponential',
        retryOn: ['timeout', 'delivery_error'],
      },
    },
    steps: [
      {
        id: 'summarize',
        kind: 'agent',
        prompt: 'Summarize my recent Discord messages.',
        timeoutMs: 15000,
      },
    ],
    delivery: {
      kind: 'originating',
    },
  });

  expect(validation.ok).toBe(true);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const yaml = renderWorkflowSpecYaml(validation.spec);
  expect(yaml).toContain('version: 2');
  expect(yaml).toContain('timeoutMs: 30000');
  expect(yaml).toContain('lightContext: true');
  expect(yaml).toContain('retryPolicy:');
  expect(yaml).toContain('strategy: "exponential"');
  expect(yaml).toContain('- id: "summarize"');
  expect(yaml).toContain('kind: "agent"');
  expect(yaml).toContain('timeoutMs: 15000');
});
