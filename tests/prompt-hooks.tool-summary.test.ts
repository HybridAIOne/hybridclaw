import { expect, test } from 'vitest';

import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { buildToolsSummary } from '../src/agent/tool-summary.js';

test('buildToolsSummary groups the full tool catalog', () => {
  const summary = buildToolsSummary();

  expect(summary).toContain('## Your Tools');
  expect(summary).toContain(
    '**Files**: `read`, `write`, `edit`, `delete`, `glob`, `grep`',
  );
  expect(summary).toContain(
    '**Browser**: `browser_navigate`, `browser_snapshot`, `browser_click`',
  );
  expect(summary).toContain('**Communication**: `message`');
  expect(summary).toContain('**Delegation**: `delegate`');
  expect(summary).toContain('**Vision**: `vision_analyze`, `image`');
});

test('buildSystemPromptFromHooks reflects restricted tool availability', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    purpose: 'memory-flush',
    promptMode: 'minimal',
    allowedTools: ['memory', 'session_search'],
    blockedTools: ['session_search'],
  });

  expect(prompt).toContain('## Your Tools');
  expect(prompt).toContain('**Memory**: `memory`');
  expect(prompt).not.toContain('**Files**:');
  expect(prompt).not.toContain('`session_search`');
  expect(prompt).not.toContain('`delegate`');
});
