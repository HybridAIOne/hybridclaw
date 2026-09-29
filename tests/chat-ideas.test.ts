import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-chat-ideas-',
});

const IDEA = { title: 'Plan', description: 'Why', prompt: 'Do it' };

async function loadFixture(content: string) {
  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'hybridai' as const,
    model: 'hybridai/gpt-5-nano',
    content,
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { generateChatIdeas } = await import('../src/gateway/chat-ideas.ts');
  initDatabase({ quiet: true });
  return {
    callAuxiliaryModelMock,
    memoryService,
    agentWorkspaceDir,
    generateChatIdeas,
  };
}

function lastPrompt(mock: ReturnType<typeof vi.fn>): string {
  const call = mock.mock.calls.at(-1)?.[0] as {
    messages: Array<{ content: string }>;
  };
  return call.messages.map((message) => message.content).join('\n');
}

test('grounds ideas in the agent persona and only the requesting user chats', async () => {
  setupHome();
  const fixture = await loadFixture(
    JSON.stringify({ ideas: Array.from({ length: 7 }, () => IDEA) }),
  );
  const workspace = fixture.agentWorkspaceDir('main');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), 'soul-marker-7');
  fs.writeFileSync(path.join(workspace, 'BOOTSTRAP.md'), 'bootstrap-marker');

  for (const [sessionId, userId, content] of [
    ['session-a', 'user_a', 'user-a-marker'],
    ['session-b', 'user_b', 'user-b-marker'],
  ] as const) {
    const session = fixture.memoryService.getOrCreateSession(
      sessionId,
      null,
      'web',
      'main',
    );
    fixture.memoryService.storeMessage({
      sessionId: session.id,
      userId,
      username: userId,
      role: 'user',
      content,
    });
  }

  const result = await fixture.generateChatIdeas({ userId: 'user_a' });

  expect(result.agentId).toBe('main');
  expect(result.ideas).toHaveLength(5);
  expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  expect(fixture.callAuxiliaryModelMock).toHaveBeenCalledWith(
    expect.objectContaining({ task: 'btw', tools: [], agentId: 'main' }),
  );
  const prompt = lastPrompt(fixture.callAuxiliaryModelMock);
  expect(prompt).toContain('soul-marker-7');
  expect(prompt).toContain('user-a-marker');
  expect(prompt).not.toContain('user-b-marker');
  expect(prompt).not.toContain('bootstrap-marker');
});

test('rejects an unknown agent before calling the model', async () => {
  setupHome();
  const fixture = await loadFixture('{}');

  await expect(
    fixture.generateChatIdeas({ userId: 'user_a', agentId: 'nobody' }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(fixture.callAuxiliaryModelMock).not.toHaveBeenCalled();
});

test.each([
  [
    'fenced JSON after reasoning',
    `<think>{"ideas":[]}</think>Sure:\n\`\`\`json\n${JSON.stringify({ ideas: [IDEA] })}\n\`\`\``,
    [IDEA],
  ],
  [
    'items missing a title or prompt',
    JSON.stringify({
      ideas: [{ title: 'x' }, { prompt: 'y' }, { ...IDEA, description: 3 }],
    }),
    [{ ...IDEA, description: '' }],
  ],
])('parseChatIdeas handles %s', async (_label, content, expected) => {
  const { parseChatIdeas } = await import('../src/gateway/chat-ideas.ts');
  expect(parseChatIdeas(content)).toEqual(expected);
});

test.each([
  'no json here',
  '{"ideas":"nope"}',
  '[]',
])('parseChatIdeas fails with 502 on %j', async (content) => {
  const { parseChatIdeas } = await import('../src/gateway/chat-ideas.ts');
  expect(() => parseChatIdeas(content)).toThrow(
    expect.objectContaining({ statusCode: 502 }),
  );
});
