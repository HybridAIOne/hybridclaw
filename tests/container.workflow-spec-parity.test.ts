import { describe, expect, test } from 'vitest';

import { normalizeWorkflowSpecInput } from '../container/src/tools.js';
import { normalizeWorkflowSpec } from '../src/workflow/types.js';

const parityCases: Array<{ name: string; input: unknown }> = [
  {
    name: 'upgrades legacy v1 schedule workflows',
    input: {
      version: 1,
      trigger: {
        kind: 'schedule',
        cronExpr: '0 9 * * *',
      },
      steps: [
        {
          id: 'summarize',
          prompt: 'Summarize the latest updates.',
        },
      ],
      delivery: {
        kind: 'email',
        target: 'me@example.com',
      },
      context: {
        audience: 'ops',
      },
    },
  },
  {
    name: 'normalizes v2 defaults, delivery, approval, and floored numeric fields',
    input: {
      version: 2,
      trigger: {
        kind: 'schedule',
        everyMs: 1500.9,
      },
      defaults: {
        timeoutMs: 30000.9,
        lightContext: true,
        retryPolicy: {
          maxAttempts: 3.9,
          backoffMs: 5000.8,
          strategy: 'exponential',
          retryOn: ['timeout', 'delivery_error', 'invalid', 'timeout'],
        },
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the incoming items.',
          timeoutMs: 15000.7,
          retryPolicy: {
            maxAttempts: 2.2,
            backoffMs: 1200.4,
            retryOn: ['timeout', 'transient', 'bogus'],
          },
          lightContext: false,
        },
        {
          id: 'approve',
          kind: 'approval',
          approvalPrompt: 'Send the summary?',
          input: '{{summarize.result}}',
          dependsOn: ['summarize'],
        },
        {
          id: 'deliver',
          kind: 'deliver',
          input: '{{summarize.result}}',
          delivery: {
            kind: 'channel',
            target: 'ops-alerts',
          },
          dependsOn: ['approve', 'summarize'],
        },
      ],
      delivery: {
        kind: 'originating',
      },
      context: {
        timezone: 'Europe/Berlin',
      },
    },
  },
  {
    name: 'rejects schedule triggers with multiple scheduling fields',
    input: {
      version: 2,
      trigger: {
        kind: 'schedule',
        cronExpr: '0 9 * * *',
        everyMs: 60000,
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the latest updates.',
        },
      ],
      delivery: {
        kind: 'originating',
      },
    },
  },
  {
    name: 'rejects keyword triggers without a content pattern',
    input: {
      version: 2,
      trigger: {
        kind: 'keyword',
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the latest updates.',
        },
      ],
      delivery: {
        kind: 'originating',
      },
    },
  },
  {
    name: 'rejects steps with unknown dependencies',
    input: {
      version: 2,
      trigger: {
        kind: 'schedule',
        cronExpr: '0 9 * * *',
      },
      steps: [
        {
          id: 'deliver',
          kind: 'deliver',
          input: '{{summarize.result}}',
          delivery: {
            kind: 'channel',
            target: 'ops-alerts',
          },
          dependsOn: ['summarize'],
        },
      ],
      delivery: {
        kind: 'originating',
      },
    },
  },
  {
    name: 'rejects duplicate step ids',
    input: {
      version: 2,
      trigger: {
        kind: 'schedule',
        cronExpr: '0 9 * * *',
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the latest updates.',
        },
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the latest updates again.',
        },
      ],
      delivery: {
        kind: 'originating',
      },
    },
  },
];

describe('workflow spec normalization parity', () => {
  for (const parityCase of parityCases) {
    test(parityCase.name, () => {
      expect(normalizeWorkflowSpecInput(parityCase.input)).toEqual(
        normalizeWorkflowSpec(parityCase.input),
      );
    });
  }

  test('container workflow normalizer keeps JSON-string input aligned', () => {
    const input = {
      version: 2,
      trigger: {
        kind: 'schedule',
        cronExpr: '0 9 * * *',
      },
      steps: [
        {
          id: 'summarize',
          kind: 'agent',
          prompt: 'Summarize the latest updates.',
        },
      ],
      delivery: {
        kind: 'originating',
      },
    };

    expect(normalizeWorkflowSpecInput(JSON.stringify(input))).toEqual(
      normalizeWorkflowSpec(input),
    );
  });
});
