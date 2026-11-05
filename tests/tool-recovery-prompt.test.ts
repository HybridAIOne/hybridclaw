import { expect, test } from 'vitest';

import { ACTION_PREREQUISITE_LINES } from '../container/shared/action-prerequisites.js';
import { TOOL_ARGUMENT_CARDINALITY } from '../container/shared/tool-argument-contract.js';
import { buildSystemPromptBlocksFromHooks, buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { TOOL_RECOVERY_LINES } from '../src/agent/tool-recovery.js';

test.each([
  { promptMode: 'full' as const },
  { promptMode: 'minimal' as const },
  { promptMode: 'full' as const, runtimeInfo: { client: 'mobile' as const } },
])(
  'includes recovery and prerequisites once at the end: %j',
  (options) => {
    const blocks = buildSystemPromptBlocksFromHooks({
      agentId: 'recovery-test',
      skills: [],
      ...options,
    });
    expect(blocks.join('\n').split(TOOL_ARGUMENT_CARDINALITY)).toHaveLength(2);
    for (const lines of [TOOL_RECOVERY_LINES, ACTION_PREREQUISITE_LINES]) {
      const policy = lines.join('\n');
      expect(blocks.join('\n').split(policy)).toHaveLength(2);
    }
    expect(blocks.at(-1)).toContain(TOOL_RECOVERY_LINES.join('\n'));
    expect(blocks.at(-1)?.endsWith(ACTION_PREREQUISITE_LINES.join('\n'))).toBe(true);
    expect(buildSystemPromptFromHooks({ agentId: 'recovery-test', skills: [], ...options }).endsWith(ACTION_PREREQUISITE_LINES.join('\n'))).toBe(true);
  },
);

test.each([{ promptMode: 'none' as const }, { omitPromptParts: ['safety' as const] }])('respects safety selection: %j', (options) => {
  const context = { agentId: 'recovery-test', skills: [], ...options };
  expect(buildSystemPromptBlocksFromHooks(context).join('\n')).not.toContain(ACTION_PREREQUISITE_LINES.join('\n'));
  expect(buildSystemPromptFromHooks(context)).not.toContain(ACTION_PREREQUISITE_LINES.join('\n'));
});
