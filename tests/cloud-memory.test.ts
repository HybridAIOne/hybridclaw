import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

async function createAgentWorkspace(agentId: string) {
  const dataDir = makeTempDir('hybridclaw-cloud-memory-');
  vi.stubEnv('HOME', dataDir);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDAI_API_KEY', 'hai-cloud-memory-test');
  vi.stubEnv('HYBRIDAI_BASE_URL', 'https://hybridai.example/');
  vi.stubEnv('HYBRIDAI_CHATBOT_ID', 'bot-cloud-memory');

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
    '# MEMORY.md\n\n- Local agent fact.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'memory', '2026-06-08.md'),
    '# Daily Memory\n\n- Local daily fact.\n',
    'utf-8',
  );
  return workspaceDir;
}

test('syncCloudMemoryNow pushes local agent memory and caches shared memory', async () => {
  const agentId = 'cloud-agent';
  await createAgentWorkspace(agentId);

  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      enabled: true,
      files: [
        {
          scope: 'installation',
          path: '/MEMORY.md',
          content: '# Installation Memory\n\n- Installed agents share this.',
          updated_at: '2026-06-08T10:00:00Z',
        },
        {
          scope: 'company',
          path: '/MEMORY.md',
          content: '# Company Memory\n\n- Company-wide fact.',
          updated_at: '2026-06-08T10:00:00Z',
        },
        {
          scope: 'agent',
          path: '/MEMORY.md',
          content: '# Agent Memory\n\n- Cloud agent fact.',
          updated_at: '2026-06-08T10:00:00Z',
        },
      ],
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  const { loadCloudMemoryContextFiles, syncCloudMemoryNow } = await import(
    '../src/memory/cloud-memory.js'
  );

  await syncCloudMemoryNow(agentId);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    'https://hybridai.example/api/hybridclaw/memory/sync',
  );
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(init.headers).toMatchObject({
    Authorization: 'Bearer hai-cloud-memory-test',
    'Content-Type': 'application/json',
  });
  const body = JSON.parse(String(init.body)) as {
    chatbot_id: string;
    agent_id: string;
    files: Array<{ scope: string; path: string; content: string }>;
  };
  expect(body.chatbot_id).toBe('bot-cloud-memory');
  expect(body.agent_id).toBe(agentId);
  expect(body.files.map((file) => file.path)).toEqual([
    '/MEMORY.md',
    '/USER.md',
    '/memory/2026-06-08.md',
  ]);
  expect(body.files.every((file) => file.scope === 'agent')).toBe(true);

  expect(loadCloudMemoryContextFiles(agentId)).toEqual([
    {
      scope: 'installation',
      name: '/MEMORY.md',
      content: '# Installation Memory\n\n- Installed agents share this.',
    },
    {
      scope: 'company',
      name: '/MEMORY.md',
      content: '# Company Memory\n\n- Company-wide fact.',
    },
  ]);
});

test('buildSystemPromptFromHooks includes cached installation and company memory', async () => {
  const agentId = 'cloud-prompt-agent';
  const workspaceDir = await createAgentWorkspace(agentId);
  fs.mkdirSync(path.join(workspaceDir, '.hybridclaw'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'cloud-memory.json'),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: '2026-06-08T10:00:00.000Z',
        files: [
          {
            scope: 'installation',
            name: '/MEMORY.md',
            content: '- Installation-level fact.',
          },
          {
            scope: 'company',
            name: '/MEMORY.md',
            content: '- Company-level fact.',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const { buildSystemPromptFromHooks } = await import(
    '../src/agent/prompt-hooks.js'
  );
  const prompt = buildSystemPromptFromHooks({
    agentId,
    skills: [],
    runtimeInfo: {
      model: 'openai-codex/gpt-5.4',
      workspacePath: '/workspace/cloud-prompt-agent',
    },
  });

  expect(prompt).toContain('Local agent fact.');
  expect(prompt).toContain('# Shared Memory');
  expect(prompt).toContain('## Installation Memory (/MEMORY.md)');
  expect(prompt).toContain('- Installation-level fact.');
  expect(prompt).toContain('## Company Memory (/MEMORY.md)');
  expect(prompt).toContain('- Company-level fact.');
});
