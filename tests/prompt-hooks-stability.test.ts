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

test('system prompt blocks isolate workspace memory updates from the static core', async () => {
  const agentId = 'system-block-agent';
  await createWorkspaceWithBootstrapFiles(agentId);
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { buildSystemPromptBlocksFromHooks } = await import(
    '../src/agent/prompt-hooks.js'
  );

  const first = buildSystemPromptBlocksFromHooks({
    agentId,
    skills: [],
  });
  fs.writeFileSync(
    path.join(agentWorkspaceDir(agentId), 'MEMORY.md'),
    '# MEMORY.md\n\n- Updated durable memory.\n',
    'utf-8',
  );
  const second = buildSystemPromptBlocksFromHooks({
    agentId,
    skills: [],
  });

  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  expect(first[0]).toBe(second[0]);
  expect(first[0]).not.toContain('Stable durable memory.');
  expect(first[1]).toContain('Stable durable memory.');
  expect(second[1]).toContain('Updated durable memory.');
  expect(first[1]).not.toBe(second[1]);
});

test('buildConversationContext appends dynamic context after unchanged history', async () => {
  vi.useFakeTimers();

  try {
    const agentId = 'dynamic-context-agent';
    await createWorkspaceWithBootstrapFiles(agentId);
    const { buildConversationContext, buildDynamicContextMessage } =
      await import('../src/agent/conversation.js');

    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    const context = buildConversationContext({
      agentId,
      sessionSummary: '### Relevant Memory Recall\n- [mem:1] Prior fact.',
      retrievedContext: 'External retrieval result.',
      history: [{ role: 'user', content: 'Hello' }],
      runtimeInfo: {
        model: 'openai-codex/gpt-5.4',
        workspacePath: '/workspace/dynamic-context-agent',
      },
    });

    const systemMessages = context.messages.filter(
      (message) => message.role === 'system',
    );
    const systemPrompt = systemMessages
      .map((message) => String(message.content || ''))
      .join('\n\n');
    expect(systemMessages.length).toBeGreaterThanOrEqual(2);
    expect(systemPrompt).not.toContain('Date (UTC):');
    expect(systemPrompt).not.toContain('Current Date & Time:');
    expect(systemPrompt).not.toContain('Stable per-turn note.');
    expect(systemPrompt).not.toContain(
      'Relevant Memory Recall',
    );
    expect(systemPrompt).not.toContain(
      'External retrieval result.',
    );
    expect(context.messages.at(-1)).toEqual(
      buildDynamicContextMessage({
        agentId,
        now: new Date('2026-05-13T12:00:00.000Z'),
        sessionSummary: '### Relevant Memory Recall\n- [mem:1] Prior fact.',
        retrievedContext: 'External retrieval result.',
      }),
    );
    const dynamicContextMessage = context.messages.at(-1);
    expect(dynamicContextMessage?.content).toContain(
      'Date (UTC): 2026-05-13',
    );
    expect(dynamicContextMessage?.content).toContain(
      'Current Date & Time: Wednesday, May 13th, 2026',
    );
    expect(dynamicContextMessage?.content).toContain('Host:');
    expect(dynamicContextMessage?.content).toContain(
      '## Daily Memory (memory/2026-05-13.md)',
    );
    expect(dynamicContextMessage?.content).toContain('Stable per-turn note.');
    expect(dynamicContextMessage?.content).toContain(
      '## Session Summary\nCompressed and recalled context',
    );
    expect(dynamicContextMessage?.content).toContain('Relevant Memory Recall');
    expect(dynamicContextMessage?.content).toContain('## Retrieved Context');
    expect(dynamicContextMessage?.content).toContain(
      'External retrieval result.',
    );
    expect(context.messages.at(-2)).toEqual({
      role: 'user',
      content: 'Hello',
    });

  } finally {
    vi.useRealTimers();
  }
});
