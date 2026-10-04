import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

beforeEach(() => {
  vi.stubEnv(
    'HYBRIDCLAW_DATA_DIR',
    makeTempDir('hybridclaw-proactive-preferences-'),
  );
});

async function setupWorkspace() {
  const workspace = await import('../src/workspace.js');
  const { PROACTIVE_PREFERENCES_FILE, readWorkspaceTemplate } = await import(
    '../src/workspace-templates.js'
  );
  const { workspacePath } = workspace.ensureBootstrapFiles('main');
  return {
    ...workspace,
    filePath: path.join(workspacePath, PROACTIVE_PREFERENCES_FILE),
    filename: PROACTIVE_PREFERENCES_FILE,
    defaultContent: readWorkspaceTemplate(PROACTIVE_PREFERENCES_FILE),
  };
}

test('seeds empty preference sections in new and existing workspaces without overwriting edits', async () => {
  const {
    filePath,
    filename,
    defaultContent,
    ensureBootstrapFiles,
    loadStaticBootstrapFiles,
  } = await setupWorkspace();
  expect(fs.readFileSync(filePath, 'utf-8')).toBe(defaultContent);
  expect(
    [...defaultContent.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
  ).toEqual(['Tell me about', 'Never tell me about', 'When', 'How']);
  expect(defaultContent).toMatch(
    /## Tell me about\s+## Never tell me about\s+## When/,
  );

  fs.unlinkSync(filePath);
  ensureBootstrapFiles('main');
  expect(fs.readFileSync(filePath, 'utf-8')).toBe(defaultContent);
  const custom = '# Preferences\nNever bring up sports.\n';
  fs.writeFileSync(filePath, custom);
  ensureBootstrapFiles('main');
  expect(fs.readFileSync(filePath, 'utf-8')).toBe(custom);
  expect(loadStaticBootstrapFiles('main')).toContainEqual({
    name: filename,
    content: custom.trim(),
  });
});

test('appends the complete current preferences including prose outside sections, leaving the system prefix stable', async () => {
  const { filePath, filename } = await setupWorkspace();
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );
  const { buildSystemPromptFromHooks } = await import(
    '../src/agent/prompt-hooks.js'
  );
  const firstPreferences =
    '# Preferences\nNo unsolicited outreach, anywhere.\n';
  fs.writeFileSync(filePath, firstPreferences);
  const first = buildConversationContext({ agentId: 'main', history: [] });
  const secondPreferences = `# Preferences\n${'Context. '.repeat(1500)}\nNever mention sports.\n## How\nOne brief line.\n`;
  fs.writeFileSync(filePath, secondPreferences);
  const second = buildConversationContext({
    agentId: 'main',
    history: [{ role: 'user', content: first.dynamicContext ?? '' }],
  });
  expect(first.dynamicContext).toContain(firstPreferences);
  expect(second.dynamicContext).toContain(secondPreferences);
  expect(
    second.messages.filter((message) => message.role === 'system'),
  ).toEqual(first.messages.filter((message) => message.role === 'system'));
  expect(second.messages.at(-2)?.content).toBe(first.dynamicContext);
  expect(
    buildSystemPromptFromHooks({ agentId: 'main', skills: [] }),
  ).not.toContain(secondPreferences);
  expect(second.dynamicContext?.split(`## ${filename}`)).toHaveLength(2);
});

test.each(['missing', 'empty', 'unreadable', 'oversized'] as const)(
  'handles %s preferences without including partial content',
  async (state) => {
    const { filePath, defaultContent, WORKSPACE_CONTEXT_FILE_MAX_CHARS } =
      await setupWorkspace();
    const { buildProactivePreferencesContext } = await import(
      '../src/agent/proactive-preferences.js'
    );
    if (state === 'missing') fs.unlinkSync(filePath);
    if (state === 'empty') fs.writeFileSync(filePath, '');
    if (state === 'unreadable') {
      fs.unlinkSync(filePath);
      fs.mkdirSync(filePath);
    }
    if (state === 'oversized')
      fs.writeFileSync(
        filePath,
        'Private preference. '.repeat(WORKSPACE_CONTEXT_FILE_MAX_CHARS),
      );
    const context = buildProactivePreferencesContext('main');
    if (state === 'missing') expect(context).toContain(defaultContent);
    if (state === 'empty') expect(context).not.toContain(defaultContent);
    if (state === 'unreadable' || state === 'oversized') {
      expect(context).not.toContain('Private preference.');
      expect(context).not.toContain('[truncated middle]');
      expect(context).toMatch(/Stay silent/);
    }
  },
);
