import { afterEach, describe, expect, test } from 'vitest';

import {
  executeTool,
  getPendingSideEffects,
  resetSideEffects,
} from '../container/src/tools.js';

describe.sequential('container delegate tool', () => {
  afterEach(() => {
    resetSideEffects();
  });

  test('explicit chain mode ignores redundant tasks payload', async () => {
    const payload = {
      mode: 'chain',
      label: 'invoice-pptx-workflow',
      model: 'openai-codex/gpt-5.4',
      tasks: [
        {
          prompt: 'analyze invoices',
          label: 'analyze',
        },
      ],
      chain: [
        {
          prompt: 'analyze invoices',
          label: 'analyze',
        },
        {
          prompt: 'build deck from {previous}',
          label: 'build',
        },
      ],
    };

    const result = await executeTool('delegate', JSON.stringify(payload));

    expect(result).toContain('Delegation accepted (chain');
    const sideEffects = getPendingSideEffects();
    expect(sideEffects?.delegations).toEqual([
      {
        action: 'delegate',
        mode: 'chain',
        label: 'invoice-pptx-workflow',
        model: 'openai-codex/gpt-5.4',
        chain: [
          {
            prompt: 'analyze invoices',
            label: 'analyze',
            model: 'openai-codex/gpt-5.4',
          },
          {
            prompt: 'build deck from {previous}',
            label: 'build',
            model: 'openai-codex/gpt-5.4',
          },
        ],
      },
    ]);
  });
});
