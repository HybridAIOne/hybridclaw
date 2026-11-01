import { expect, test } from 'vitest';

import { buildSystemPromptBlocksFromHooks } from '../src/agent/prompt-hooks.js';
import { TOOL_RECOVERY_LINES } from '../src/agent/tool-recovery.js';

test.each([
  { promptMode: 'full' as const },
  { promptMode: 'minimal' as const },
  { promptMode: 'full' as const, runtimeInfo: { client: 'mobile' as const } },
])(
  'includes the shared recovery policy once in the static core: %j',
  (options) => {
    const blocks = buildSystemPromptBlocksFromHooks({
      agentId: 'recovery-test',
      skills: [],
      ...options,
    });
    const policy = TOOL_RECOVERY_LINES.join('\n');
    expect(blocks[0]).toContain(policy);
    expect(blocks.join('\n').split(policy)).toHaveLength(2);
    expect(blocks.slice(1).join('\n')).not.toContain(policy);
  },
);
