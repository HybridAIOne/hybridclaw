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
  expect(summary).toContain(
    '**Web**: `web_search`, `web_fetch`, `web_extract`',
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
  expect(prompt).not.toContain('**Delegation**:');
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
    location: 'skills/pdf/SKILL.md',
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
  expect(prompt).toContain(
    'Treat paths under `skills/` as bundled, read-only skill assets for normal user work.',
  );
  expect(prompt).toContain(
    'For normal user work, put generated scripts in workspace `scripts/` or the workspace root. Only write under `skills/` when the user explicitly asked to create or edit a skill.',
  );
  expect(prompt).toContain('<available_skills>');
  expect(prompt).toContain('<name>pdf</name>');
  expect(prompt).toContain('<location>skills/pdf/SKILL.md</location>');
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
    'For fresh deliverable-generation tasks from a folder of source files, use the primary source inputs directly and create a new output.',
  );
  expect(prompt).toContain(
    'For channel catch-up or recap requests with partial scope, infer a reasonable recent scope from available context, do a best-effort read first, and note assumptions after the summary instead of blocking on a clarification.',
  );
  expect(prompt).toContain(
    'For local Discord, WhatsApp, or email uploads, call `message` with `action="send"` and `filePath` pointing to a file in the current workspace or `/discord-media-cache`.',
  );
  expect(prompt).toContain(
    'When the user asks you to create or generate a file and return/upload/post it, include the file immediately in the final delivery. Do not ask a follow-up question offering to upload it later.',
  );
  expect(prompt).toContain(
    'For deliverable-generation tasks such as presentations, slide decks, spreadsheets, documents, PDFs, reports, or images, assume the created asset should be attached in the final reply unless the user explicitly says not to send the file.',
  );
  expect(prompt).toContain(
    'If you created or updated the requested deliverable successfully, prefer posting the asset immediately over replying with a path plus "if you want, I can upload it."',
  );
  expect(prompt).toContain(
    'For deliverable-generation tasks, once the requested file exists and the generation command succeeded, stop.',
  );
  expect(prompt).toContain(
    'Follow the runtime capability hint for Office QA/export steps instead of assuming tools like `soffice` or `pdftoppm` are available.',
  );
  expect(prompt).toContain(
    'Do not mention missing Office/PDF QA tools in the final reply unless the user asked for QA/export/validation',
  );
  expect(prompt).toContain(
    'For new `pptxgenjs` decks, do not use OOXML shorthand values in table options. Never set table-cell `valign: "mid"` and never emit raw `anchor: "mid"`.',
  );
  expect(prompt).toContain(
    'Never write plain text placeholder content to binary office files such as `.docx`, `.xlsx`, `.pptx`, or `.pdf`. If generation fails, report the error instead of creating a fake file.',
  );
  expect(prompt).toContain(
    'User: "Post `invoices/dashboard.html.png` here on Discord"',
  );
  expect(prompt).toContain(
    'Tool call: `message` {"action":"send","filePath":"invoices/dashboard.html.png"}',
  );
  expect(prompt).toContain(
    'User: "Send this to WhatsApp +491701234567: landed safely"',
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

test('buildSystemPromptFromHooks uses the provided workspace path in runtime metadata', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    runtimeInfo: {
      workspacePath: '/tmp/hybridclaw-agent-workspace',
    },
  });

  expect(prompt).toContain('Workspace: /tmp/hybridclaw-agent-workspace');
});

test('buildSystemPromptFromHooks does not fall back to the repo cwd', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
  });

  expect(prompt).toContain('Workspace: current agent workspace');
  expect(prompt).not.toContain(process.cwd());
});

test('buildSystemPromptFromHooks includes email signature guidance for email context', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    runtimeInfo: {
      channelType: 'email',
      channelId: 'peer@example.com',
    },
  });

  expect(prompt).toContain('Current email peer: `peer@example.com`');
  expect(prompt).toContain(
    'append a polished corporate signature block derived from the identity details already loaded from `IDENTITY.md`',
  );
  expect(prompt).toContain('do not use emoji or mascot-style sign-offs');
  expect(prompt).toContain(
    'make a reasonable best-effort assumption, do the useful work first, and mention the assumption after the answer',
  );
});
