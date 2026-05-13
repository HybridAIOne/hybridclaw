import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
});

async function createWorkspaceWithBootstrapFiles(agentId: string) {
  const dataDir = makeTempDir('hybridclaw-prompt-stability-');
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const workspaceDir = agentWorkspaceDir(agentId);
  fs.mkdirSync(path.join(workspaceDir, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'USER.md'),
    '# USER.md\n\n- **Timezone:** Europe/Berlin\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'MEMORY.md'),
    '# MEMORY.md\n\n- Stable durable memory.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'memory', '2026-05-13.md'),
    '# Daily Memory\n\n- Stable per-turn note.\n',
    'utf-8',
  );
}

test('buildSystemPromptFromHooks is byte-stable across same-date turns', async () => {
  vi.useFakeTimers();

  try {
    const agentId = 'stability-agent';
    await createWorkspaceWithBootstrapFiles(agentId);
    const { buildSystemPromptFromHooks } = await import(
      '../src/agent/prompt-hooks.js'
    );

    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    const firstPrompt = buildSystemPromptFromHooks({
      agentId,
      skills: [],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        channelType: 'discord',
        channelId: 'channel-1',
        guildId: 'guild-1',
        workspacePath: '/workspace/stability-agent',
      },
    });

    vi.setSystemTime(new Date('2026-05-13T12:01:00.000Z'));
    const secondPrompt = buildSystemPromptFromHooks({
      agentId,
      skills: [],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        channelType: 'discord',
        channelId: 'channel-1',
        guildId: 'guild-1',
        workspacePath: '/workspace/stability-agent',
      },
    });

    expect(secondPrompt).toBe(firstPrompt);
    expect(firstPrompt).not.toContain('Date (UTC):');
    expect(firstPrompt).not.toContain('Current Date & Time:');
    expect(firstPrompt).not.toContain('Host:');
    expect(firstPrompt).not.toContain('memory/2026-05-13.md');
    expect(firstPrompt).toContain('Stable durable memory.');
  } finally {
    vi.useRealTimers();
  }
});

test('buildConversationContext appends dynamic context before history', async () => {
  vi.useFakeTimers();

  try {
    const agentId = 'dynamic-context-agent';
    await createWorkspaceWithBootstrapFiles(agentId);
    const { buildConversationContext, buildDynamicContextMessage } =
      await import('../src/agent/conversation.js');

    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    const context = buildConversationContext({
      agentId,
      history: [{ role: 'user', content: 'Hello' }],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        workspacePath: '/workspace/dynamic-context-agent',
      },
    });

    expect(context.messages[0]?.role).toBe('system');
    expect(context.messages[0]?.content).not.toContain('Date (UTC):');
    expect(context.messages[0]?.content).not.toContain('Current Date & Time:');
    expect(context.messages[0]?.content).not.toContain('Stable per-turn note.');
    expect(context.messages[1]).toEqual(
      buildDynamicContextMessage({
        agentId,
        now: new Date('2026-05-13T12:00:00.000Z'),
      }),
    );
    expect(context.messages[1]?.content).toContain('Date (UTC): 2026-05-13');
    expect(context.messages[1]?.content).toContain(
      'Current Date & Time: Wednesday, May 13th, 2026',
    );
    expect(context.messages[1]?.content).toContain('Host:');
    expect(context.messages[1]?.content).toContain(
      '## Daily Memory (memory/2026-05-13.md)',
    );
    expect(context.messages[1]?.content).toContain('Stable per-turn note.');
    expect(context.messages[2]).toEqual({ role: 'user', content: 'Hello' });
  } finally {
    vi.useRealTimers();
  }
});
