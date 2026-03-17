import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-gateway-workflow-'),
  );
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  runAgentMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('workflow commands compile, persist, list, describe, history, toggle, and remove workflows', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const dbModule = await import('../src/memory/db.ts');
  dbModule.initDatabase({ quiet: true });

  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: 'Compiled workflow.',
    toolsUsed: ['workflow'],
    sideEffects: {
      workflows: [
        {
          action: 'create',
          name: 'Daily digest',
          description: 'Summarize updates every morning.',
          naturalLanguage:
            'Every day at 9am, summarize my recent Discord messages and email me.',
          spec: {
            version: 2,
            trigger: {
              kind: 'schedule',
              cronExpr: '0 9 * * *',
            },
            defaults: {
              timeoutMs: 30000,
              lightContext: true,
            },
            steps: [
              {
                id: 'summarize',
                kind: 'agent',
                prompt: 'Summarize my recent Discord messages.',
              },
            ],
            delivery: {
              kind: 'email',
              target: 'me@example.com',
            },
          },
        },
      ],
    },
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const sessionId = 'session-workflow';
  const channelId = '123456789012345678';

  const created = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId,
    args: [
      'workflow',
      'create',
      'Every',
      'day',
      'at',
      '9am,',
      'summarize',
      'my',
      'recent',
      'Discord',
      'messages',
      'and',
      'email',
      'me.',
    ],
  });
  expect(created.kind).toBe('plain');
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      allowedTools: ['workflow'],
      channelId,
      sessionId,
    }),
  );

  const createdWorkflow = dbModule.listWorkflows({ sessionId })[0];
  expect(createdWorkflow).toBeDefined();
  expect(createdWorkflow.name).toBe('Daily digest');
  expect(dbModule.getTasksForSession(sessionId)).toHaveLength(1);

  const listed = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId,
    args: ['workflow', 'list'],
  });
  expect(listed.kind).toBe('info');
  if (listed.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${listed.kind}`);
  }
  expect(listed.text).toContain('Daily digest');
  expect(listed.text).toContain('email me@example.com');

  const described = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId,
    args: ['workflow', 'describe', String(createdWorkflow.id)],
  });
  expect(described.kind).toBe('info');
  if (described.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${described.kind}`);
  }
  expect(described.text).toContain('Name: Daily digest');
  expect(described.text).toContain('Enabled: yes');
  expect(described.text).toContain('"version": 2');
  expect(described.text).toContain('"cronExpr": "0 9 * * *"');
  expect(described.text).toContain('"kind": "agent"');
  expect(described.text).toContain('"target": "me@example.com"');

  const history = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId,
    args: ['workflow', 'history', String(createdWorkflow.id)],
  });
  expect(history.kind).toBe('info');
  if (history.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${history.kind}`);
  }
  expect(history.text).toContain('workflow.created');

  const toggled = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId,
    args: ['workflow', 'toggle', String(createdWorkflow.id)],
  });
  expect(toggled.kind).toBe('plain');
  expect(dbModule.getWorkflow(createdWorkflow.id)?.enabled).toBe(0);

  const removed = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId,
    args: ['workflow', 'remove', String(createdWorkflow.id)],
  });
  expect(removed.kind).toBe('plain');
  expect(dbModule.listWorkflows({ sessionId })).toHaveLength(0);
  expect(dbModule.getTasksForSession(sessionId)).toHaveLength(0);
});
