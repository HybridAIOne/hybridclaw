import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/session/session-title.js', () => ({
  startSessionTitle: vi.fn(),
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-chat-skill-workspace-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test.each([
  { mode: 'host' as const, separate: true },
  { mode: 'host' as const, separate: false },
  { mode: 'container' as const, separate: true },
  { mode: 'container' as const, separate: true, override: 'host' as const },
  { mode: 'host' as const, separate: true, override: 'container' as const },
])(
  'only separate host execution advertises host skill paths: $mode/$separate',
  async ({ mode, separate, ...rest }) => {
    const override = 'override' in rest ? rest.override : undefined;
    const host = (override ?? mode) === 'host';
    const home = setupHome();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { initDatabase } = await import('../src/memory/db.js');
    initDatabase({ quiet: true });
    const { updateRuntimeConfig } = await import(
      '../src/config/runtime-config.js'
    );
    const extra = path.join(home, 'extra-skills');
    fs.mkdirSync(path.join(extra, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(extra, 'notes/SKILL.md'),
      '---\nname: notes\ndescription: Organize notes\n---\nRead source notes.\n',
    );
    updateRuntimeConfig((draft) => {
      draft.container.sandboxMode = mode;
      draft.skills.extraDirs = [extra];
    });
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    const { ensureBootstrapFiles, completeWorkspaceOnboarding } = await import(
      '../src/workspace.js'
    );
    ensureBootstrapFiles('main');
    const state = agentWorkspaceDir('main');
    fs.rmSync(path.join(state, 'BOOTSTRAP.md'), { force: true });
    completeWorkspaceOnboarding('main');
    const project = path.join(home, 'project');
    fs.mkdirSync(project);
    runAgentMock.mockResolvedValue({
      status: 'success',
      result: 'Done.',
      toolsUsed: [],
      toolExecutions: [],
    });
    const { handleGatewayMessage } = await import(
      '../src/gateway/gateway-chat-service.js'
    );
    await handleGatewayMessage({
      sessionId: 'web:skill-workspace',
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      username: 'web',
      agentId: 'main',
      model: 'openai-codex/gpt-5-codex',
      chatbotId: '',
      content: 'Organize notes.',
      executorModeOverride: override,
      ...(separate ? { workspacePathOverride: project } : {}),
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const request = runAgentMock.mock.calls[0][0] as ExecutorRequest;
    const location = request.skillCatalog?.find(
      (skill) => skill.name === 'notes',
    )?.location;
    expect(location).toBe(
      host && separate
        ? path.join(state, 'skills/notes/SKILL.md')
        : 'skills/notes/SKILL.md',
    );
    if (host && separate) {
      expect(fs.existsSync(location ?? '')).toBe(true);
      const text = request.messages
        .map((message) => String(message.content))
        .join('\n');
      expect(text).toContain(state);
      expect(text).toContain(project);
    }
    expect(fs.readdirSync(project)).toEqual([]);
  },
);
