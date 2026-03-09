import { expect, test } from 'vitest';

import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { buildToolsSummary } from '../src/agent/tool-summary.js';
import type { Skill } from '../src/skills/skills.js';

test('buildToolsSummary groups the full tool catalog', () => {
  const summary = buildToolsSummary();

  expect(summary).toContain('## Your Tools');
  expect(summary).toContain(
    '**Files**: `read`, `write`, `edit`, `delete`, `glob`, `grep`',
  );
  expect(summary).toContain(
    '**Browser**: `browser_navigate`, `browser_snapshot`, `browser_click`',
  );
  expect(summary).toContain('**Web**: `web_search`, `web_fetch`');
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

test('buildToolsSummary groups MCP tools separately from other tools', () => {
  const summary = buildToolsSummary({
    allowedTools: ['read', 'playwright__navigate', 'tavily__search'],
  });

  expect(summary).toContain('**Files**: `read`');
  expect(summary).toContain(
    '**MCP**: `playwright__navigate`, `tavily__search`',
  );
  expect(summary).not.toContain('**Other**:');
});

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'pdf',
    description: 'Use this skill for PDF work.',
    userInvocable: true,
    disableModelInvocation: false,
    always: false,
    requires: {
      bins: [],
      env: [],
    },
    metadata: {
      hybridclaw: {
        tags: [],
        relatedSkills: [],
        install: [],
      },
    },
    filePath: '/tmp/pdf/SKILL.md',
    baseDir: '/tmp/pdf',
    source: 'bundled',
    location: '/workspace/skills/pdf/SKILL.md',
    ...overrides,
  };
}

test('buildSystemPromptFromHooks adds mandatory routing instructions for available skills', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [makeSkill()],
  });

  expect(prompt).toContain('## Skills (mandatory)');
  expect(prompt).toContain(
    'If exactly one skill clearly applies: read its SKILL.md at `<location>` with `read`, then follow it.',
  );
  expect(prompt).toContain('<available_skills>');
  expect(prompt).toContain('<name>pdf</name>');
  expect(prompt).toContain(
    '<location>/workspace/skills/pdf/SKILL.md</location>',
  );
  expect(prompt).toContain(
    'Default: do not narrate routine, low-risk tool calls; just call the tool.',
  );
  expect(prompt).toContain(
    'If the relevant content is already available directly in the current turn, injected `<file>` content, or `[PDFContext]`, answer from that content first before reading skills or searching for the same artifact again.',
  );
  expect(prompt).toContain(
    'If the current turn already includes an attachment, local file path, `MediaItems`, injected `<file>` content, or `[PDFContext]`, use that artifact first.',
  );
  expect(prompt).toContain(
    'User: "Pull the key fields from this attached invoice PDF."',
  );
  expect(prompt).toContain(
    'Action: use that attachment content directly; do not call `message` `read`, `glob`, `find`, or read `skills/pdf/SKILL.md` first.',
  );
  expect(prompt).toContain(
    'For structured documents, extracted fields, and comparisons, prefer complete field coverage over extreme brevity.',
  );
});

test('buildSystemPromptFromHooks omits mandatory routing instructions when no skills are available', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
  });

  expect(prompt).not.toContain('## Skills (mandatory)');
  expect(prompt).not.toContain('<available_skills>');
});
