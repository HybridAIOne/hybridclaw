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

function promptContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter(Boolean)
    .join('\n\n');
}

function requestSystemPrompt(
  messages: Array<{ content: unknown; role: string }> | undefined,
): string {
  return (messages || [])
    .filter((message) => message.role === 'system')
    .map((message) => promptContentText(message.content))
    .join('\n\n');
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
  const userMessage = request?.messages?.at(-1);
  const systemPrompt = requestSystemPrompt(request?.messages);

  expect(systemPrompt).toContain('## Skills (mandatory)');
  expect(userMessage?.role).toBe('user');
  const userPrompt = promptContentText(userMessage?.content);
  expect(userPrompt).toContain('[Explicit skill invocation]');
  expect(userPrompt).toContain(
    'Use the "render-demo" skill for this request.',
  );
  expect(userPrompt).toContain(
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
  const userMessage = request?.messages?.at(-1);
  const systemPrompt = requestSystemPrompt(request?.messages);

  expect(systemPrompt).toContain('## Skills (mandatory)');
  expect(userMessage?.role).toBe('user');
  const userPrompt = promptContentText(userMessage?.content);
  expect(userPrompt).toContain('/help');
  expect(userPrompt).not.toContain('[Explicit skill invocation]');
});

test('inherits the most recent explicit skill for a later follow-up turn', async () => {
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
  writeInvocableSkill(DEFAULT_RUNTIME_HOME_DIR, 'voiceover-demo');

  await handleGatewayMessage({
    sessionId: 'session-skill-followup-most-recent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: '/render_demo create a short explainer',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  await handleGatewayMessage({
    sessionId: 'session-skill-followup-most-recent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: 'Continue and render the video',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  await handleGatewayMessage({
    sessionId: 'session-skill-followup-most-recent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: '/voiceover_demo add narration',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  runAgentMock.mockClear();

  await handleGatewayMessage({
    sessionId: 'session-skill-followup-most-recent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    content: 'Continue and polish the narration',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ content: string; role: string }>;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);

  expect(userMessage?.role).toBe('user');
  const userPrompt = promptContentText(userMessage?.content);
  expect(userPrompt).toContain('[Explicit skill invocation]');
  expect(userPrompt).toContain(
    'Use the "voiceover-demo" skill for this request.',
  );
  expect(userPrompt).toContain(
    'Skill input: Continue and polish the narration',
  );
});

test('ignores non-string previous user content when resolving follow-up skills', async () => {
  const runtimeHomeDir = setupHome();
  writeInvocableSkill(runtimeHomeDir, 'render-demo');

  const { buildConversationContext } = await import(
    '../src/agent/conversation.ts'
  );

  const context = buildConversationContext({
    agentId: 'main',
    history: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/render-demo.png' },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Rendered the draft video.',
      },
      {
        role: 'user',
        content: '/render_demo create a short explainer',
      },
    ],
    currentUserContent: 'Continue and render the video',
  });

  expect(context.explicitSkillInvocation).toBeNull();
});
