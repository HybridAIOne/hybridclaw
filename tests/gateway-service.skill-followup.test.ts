import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-skill-followup-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

function writeInvocableSkill(runtimeHomeDir: string, skillName: string): void {
  const skillDir = path.join(runtimeHomeDir, 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: Test rendering skill',
      'user-invocable: true',
      '---',
      '',
      '# Test Skill',
      '',
      'Use this skill for rendering follow-up requests.',
    ].join('\n'),
    'utf8',
  );
}

test('inherits the previous explicit skill for a short follow-up turn', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { DEFAULT_RUNTIME_HOME_DIR } = await import(
    '../src/config/runtime-paths.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  writeInvocableSkill(DEFAULT_RUNTIME_HOME_DIR, 'render-demo');

  await handleGatewayMessage({
    sessionId: 'session-skill-followup',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: '/render_demo create a short explainer',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  runAgentMock.mockClear();

  await handleGatewayMessage({
    sessionId: 'session-skill-followup',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: 'Continue and render the video',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const systemMessage = request?.messages?.[0];
  const userMessage = request?.messages?.at(-1);

  expect(systemMessage?.role).toBe('system');
  expect(systemMessage?.content).not.toContain('## Skills (mandatory)');
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain('[Explicit skill invocation]');
  expect(userMessage?.content).toContain(
    'Use the "render-demo" skill for this request.',
  );
  expect(userMessage?.content).toContain(
    'Skill input: Continue and render the video',
  );
});

test('does not inherit the previous explicit skill for a new slash-style turn', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { DEFAULT_RUNTIME_HOME_DIR } = await import(
    '../src/config/runtime-paths.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  writeInvocableSkill(DEFAULT_RUNTIME_HOME_DIR, 'render-demo');

  await handleGatewayMessage({
    sessionId: 'session-skill-no-followup',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: '/render_demo create a short explainer',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  runAgentMock.mockClear();

  await handleGatewayMessage({
    sessionId: 'session-skill-no-followup',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: '/help',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const systemMessage = request?.messages?.[0];
  const userMessage = request?.messages?.at(-1);

  expect(systemMessage?.role).toBe('system');
  expect(systemMessage?.content).toContain('## Skills (mandatory)');
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toBe('/help');
  expect(userMessage?.content).not.toContain('[Explicit skill invocation]');
});
