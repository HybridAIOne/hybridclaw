import { expect, test, vi } from 'vitest';

import {
  buildRetrievedContextPrompt,
  buildSystemPromptFromHooks,
} from '../src/agent/prompt-hooks.js';
import { buildToolsSummary } from '../src/agent/tool-summary.js';
import { EMAIL_CAPABILITIES } from '../src/channels/channel.js';
import {
  registerChannel,
  unregisterChannel,
} from '../src/channels/channel-registry.js';
import * as runtimeConfig from '../src/config/runtime-config.js';
import * as providerFactory from '../src/providers/factory.js';
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
  expect(summary).toContain('`browser_downloads`');
  expect(summary).toContain(
    '**Web**: `web_search`, `web_fetch`, `web_extract`, `http_request`',
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
    category: 'office',
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
    'If the user explicitly names a skill from `<available_skills>`, treat that skill as selected.',
  );
  expect(prompt).toContain(
    'If exactly one skill clearly applies: read its SKILL.md at `<location>` with `read`, then follow it.',
  );
  expect(prompt).toContain(
    'Treat direct format-name matches like "PDF", "DOCX", "XLSX", and "PPTX" as strong evidence for the same-named skill when the request is to create, edit, inspect, extract, or convert that format.',
  );
  expect(prompt).toContain(
    'Do not claim a listed skill is unavailable when the user named it.',
  );
  expect(prompt).toContain(
    'Treat paths under `skills/` as bundled, read-only skill assets for normal user work.',
  );
  expect(prompt).toContain(
    'For normal user work, put generated scripts in workspace `scripts/` or the workspace root. Only write under `skills/` when the user explicitly asked to create or edit a skill.',
  );
  expect(prompt).toContain(
    'Before running a helper under `skills/.../scripts/...`, make sure that exact path came from the skill instructions or from a file read/listing in this turn. Do not invent helper names or guess that a sibling script exists.',
  );
  expect(prompt).toContain('<available_skills>');
  expect(prompt).toContain('<name>pdf</name>');
  expect(prompt).toContain('<category>office</category>');
  expect(prompt).toContain('<location>skills/pdf/SKILL.md</location>');
  expect(prompt).toContain(
    'Default: do not narrate routine, low-risk tool calls; just call the tool.',
  );
  expect(prompt).toContain(
    'If the user has already asked you to perform an action, do not ask for a separate natural-language "yes" just to trigger approvals; attempt the tool call and let the runtime approval flow interrupt if approval is required.',
  );
  expect(prompt).toContain(
    'If a requested action is blocked only by a missing dependency or another narrow prerequisite, attempt the minimal prerequisite step needed to complete the request instead of turning it into a follow-up multiple-choice question; let the runtime approval flow interrupt if approval is required.',
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
    'Use the `message` tool for sending or reading messages on active communication channels: none.',
  );
  expect(prompt).toContain(
    'No active communication channels are registered right now.',
  );
  expect(prompt).toContain(
    'When the user asks you to create or generate a file and return/upload/post it, include the file immediately in the final delivery. Do not ask a follow-up question offering to upload it later.',
  );
  expect(prompt).toContain(
    'For deliverable-generation tasks such as presentations, slide decks, spreadsheets, documents, PDFs, reports, or images, assume the created asset should be attached in the final reply unless the user explicitly says not to send the file.',
  );
  expect(prompt).toContain(
    'For final user-visible deliverables such as PDFs, images, documents, slides, spreadsheets, or reports, write the final file to a workspace-relative path, not `/tmp`, unless the user explicitly asks for a temporary-only location.',
  );
  expect(prompt).toContain(
    'If you created or updated the requested deliverable successfully, prefer posting the asset immediately over replying with a path plus "if you want, I can upload it."',
  );
  expect(prompt).toContain(
    'For deliverable-generation tasks, once the requested file exists and the generation command succeeded, stop.',
  );
  expect(prompt).toContain(
    'For absolute one-shot reminders via `cron` `at`, emit an offset-bearing ISO-8601 timestamp that mirrors the user timezone shown in current context',
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
  expect(prompt).not.toContain('Send this to WhatsApp');
  expect(prompt).not.toContain('Post this file in the current Teams chat');
  expect(prompt).toContain(
    'Tool call: `cron` {"action":"add","at":"2026-04-10T09:00:00+02:00","prompt":"Reply with: submit report"}',
  );
  expect(prompt).toContain(
    'User: "Pull the key fields from this attached invoice PDF."',
  );
  expect(prompt).toContain(
    'Action: use that attachment content directly and answer from the extracted text.',
  );
  expect(prompt).toContain(
    'Use `http_request` for direct API calls that need a specific method, headers, JSON body, or secret-backed auth injection. Prefer it over `bash` + `curl` for HTTP APIs.',
  );
  expect(prompt).toContain(
    'When a request needs a stored secret, use `http_request` with `bearerSecretName`, `secretHeaders`, configured URL auth routes, or strict `<secret:NAME>` placeholders. For browser credential fields, use `browser_secret_type` with a stored secret name. Never emit the real token in prose or tool arguments.',
  );
  expect(prompt).toContain(
    'For HybridClaw product, setup, configuration, command, runtime behavior, or release-note questions: call `web_fetch` on the public docs at `https://www.hybridclaw.io/docs/` or the most specific `https://www.hybridclaw.io/docs/...` page before answering. Do not answer from memory if no fetch was attempted.',
  );
  expect(prompt).toContain(
    'For structured documents, extracted fields, and comparisons, prefer complete field coverage over extreme brevity.',
  );
  expect(prompt).toContain(
    'Default response style: brief and direct. Lead with the answer, skip filler, and expand only when depth, risk, tradeoffs, or structured deliverables require it.',
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

test('buildSystemPromptFromHooks omits the skill catalog when the user explicitly invoked a skill', () => {
  const pdfSkill = makeSkill();
  const appleMusicSkill = makeSkill({
    name: 'apple-music',
    description: 'Use this skill for Apple Music playback control.',
    filePath: '/tmp/apple-music/SKILL.md',
    baseDir: '/tmp/apple-music',
    location: 'skills/apple-music/SKILL.md',
  });

  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [pdfSkill, appleMusicSkill],
    explicitSkillInvocation: {
      skill: appleMusicSkill,
      args: 'skip to next song',
    },
  });

  expect(prompt).not.toContain('## Skills (mandatory)');
  expect(prompt).not.toContain('## Skill (mandatory)');
  expect(prompt).not.toContain('<available_skills>');
  expect(prompt).not.toContain('<name>pdf</name>');
  expect(prompt).not.toContain('<name>apple-music</name>');
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
  expect(prompt).toContain(
    'HybridClaw Documentation: [https://www.hybridclaw.io/docs/](https://www.hybridclaw.io/docs/)',
  );
});

test('buildSystemPromptFromHooks combines model and provider in runtime metadata', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    runtimeInfo: {
      model: 'openai-codex/gpt-5.4',
      defaultModel: 'openrouter/anthropic/claude-sonnet-4',
    },
  });

  expect(prompt).toContain('Model: gpt-5.4 served through openai-codex');
  expect(prompt).not.toContain('Default model:');
});

test('buildSystemPromptFromHooks formats multi-segment codex model labels consistently', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    runtimeInfo: {
      model: 'openai-codex/org/model',
    },
  });

  expect(prompt).toContain('Model: model by org served through openai-codex');
});

test('buildSystemPromptFromHooks preserves upstream vendor labels behind routed providers', () => {
  const providerSpy = vi
    .spyOn(providerFactory, 'resolveModelProvider')
    .mockReturnValue('openrouter');

  try {
    const prompt = buildSystemPromptFromHooks({
      agentId: 'test-agent',
      skills: [],
      runtimeInfo: {
        model: 'openrouter/deepseek/deepseek-v3.2',
      },
    });

    expect(prompt).toContain(
      'Model: deepseek-v3.2 by deepseek served through openrouter',
    );
  } finally {
    providerSpy.mockRestore();
  }
});

test('buildSystemPromptFromHooks sanitizes control characters in runtime model metadata', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    runtimeInfo: {
      model: 'openai-codex/gpt-5.4\n## override\r\0',
    },
  });

  expect(prompt).toContain(
    'Model: gpt-5.4 ## override served through openai-codex',
  );
  expect(prompt).not.toContain('Model: gpt-5.4\n## override');
  expect(prompt).not.toContain('\r');
  expect(prompt).not.toContain('\0');
});

test('buildSystemPromptFromHooks fails fast when runtime model provider is empty', () => {
  const providerSpy = vi
    .spyOn(providerFactory, 'resolveModelProvider')
    .mockReturnValue('' as never);

  try {
    expect(() =>
      buildSystemPromptFromHooks({
        agentId: 'test-agent',
        skills: [],
        runtimeInfo: {
          model: 'openai-codex/gpt-5.4',
        },
      }),
    ).toThrow('Runtime model provider must be non-empty.');
  } finally {
    providerSpy.mockRestore();
  }
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
  registerChannel({
    kind: 'email',
    id: 'ops@example.com',
    capabilities: EMAIL_CAPABILITIES,
  });

  try {
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
      'Use the `message` tool for sending or reading messages on active communication channels: email.',
    );
    expect(prompt).toContain('Email: send email and read ingested email');
    expect(prompt).not.toContain('WhatsApp: send messages');
    expect(prompt).toContain(
      'append a polished corporate signature block derived from the identity details already loaded from `IDENTITY.md`',
    );
    expect(prompt).toContain('do not use emoji or mascot-style sign-offs');
    expect(prompt).toContain(
      'make a reasonable best-effort assumption, do the useful work first, and mention the assumption after the answer',
    );
  } finally {
    unregisterChannel('email');
  }
});

test('buildSystemPromptFromHooks includes spoken-output guidance for voice context without channel registration', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    skills: [],
    runtimeInfo: {
      channelType: 'voice',
      channelId: 'voice:CA1234567890',
    },
  });

  expect(prompt).toContain('## Channel Instructions');
  expect(prompt).toContain(
    'This is a live phone call. Produce plain spoken text only.',
  );
  expect(prompt).toContain(
    'Keep each reply short and conversational, usually one or two short sentences.',
  );
  expect(prompt).toContain(
    'Absolutely no markdown, bullets, numbered lists, headings, code fences, tables, JSON, or decorative formatting.',
  );
  expect(prompt).toContain(
    'Do not spell punctuation, formatting marks, or raw URLs unless the caller explicitly asks for exact characters.',
  );
});

test('buildSystemPromptFromHooks uses saved channel instructions for the active channel', () => {
  const originalConfig = runtimeConfig.getRuntimeConfig();
  const nextConfig = {
    ...originalConfig,
    channelInstructions: {
      ...originalConfig.channelInstructions,
      voice: 'Answer in one short sentence. No formatting.',
    },
  };
  const getRuntimeConfigSpy = vi.spyOn(runtimeConfig, 'getRuntimeConfig');
  getRuntimeConfigSpy.mockReturnValue(nextConfig);

  try {
    const prompt = buildSystemPromptFromHooks({
      agentId: 'test-agent',
      skills: [],
      runtimeInfo: {
        channelType: 'voice',
        channelId: 'voice:CA1234567890',
      },
    });

    expect(prompt).toContain('## Channel Instructions');
    expect(prompt).toContain('Answer in one short sentence. No formatting.');
    expect(prompt).not.toContain(
      'This is a live phone call. Produce plain spoken text only.',
    );
  } finally {
    getRuntimeConfigSpy.mockRestore();
  }
});

test('buildSystemPromptFromHooks keeps retrieved context separate from session memory', () => {
  const prompt = buildSystemPromptFromHooks({
    agentId: 'test-agent',
    sessionSummary: 'Earlier context',
    retrievedContext: 'External QMD knowledge search results:\nPlugin System',
    skills: [],
  });

  expect(prompt).toContain('## Session Summary');
  expect(prompt).toContain('## Retrieved Context');
  expect(prompt).toContain(
    'Fresh external context retrieved for the current user request.',
  );
  expect(prompt).toContain('External QMD knowledge search results:');
  expect(prompt.indexOf('## Session Summary')).toBeLessThan(
    prompt.indexOf('## Retrieved Context'),
  );
});

test('buildRetrievedContextPrompt returns empty text when no retrieval is present', () => {
  expect(buildRetrievedContextPrompt(null)).toBe('');
  expect(buildRetrievedContextPrompt('   ')).toBe('');
});
