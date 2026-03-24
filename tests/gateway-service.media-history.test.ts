import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-media-history-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('handleGatewayMessage stores user-visible attachment summaries instead of raw MediaContext blocks', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'It is a screenshot.',
    toolsUsed: ['vision_analyze'],
    toolExecutions: [],
    effectiveUserPrompt: [
      "What's in this image?",
      '',
      '[MediaContext]',
      'MediaPaths: ["/Users/example/.hybridclaw/data/uploaded-media-cache/2026-03-24/upload.png"]',
      'ImageMediaPaths: ["/Users/example/.hybridclaw/data/uploaded-media-cache/2026-03-24/upload.png"]',
    ].join('\n'),
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sessionId = 'web:media-history';
  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'web',
    content: "What's in this image?",
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: '/Users/example/.hybridclaw/data/uploaded-media-cache/2026-03-24/upload.png',
        url: '/api/artifact?path=%2FUsers%2Fexample%2F.hybridclaw%2Fdata%2Fuploaded-media-cache%2F2026-03-24%2Fupload.png',
        originalUrl:
          '/api/artifact?path=%2FUsers%2Fexample%2F.hybridclaw%2Fdata%2Fuploaded-media-cache%2F2026-03-24%2Fupload.png',
        mimeType: 'image/png',
        sizeBytes: 50_355,
        filename: 'upload.png',
      },
    ],
  });

  expect(result.status).toBe('success');

  const history = memoryService.getConversationHistory(sessionId, 10);
  const userMessage = history.find((message) => message.role === 'user');
  expect(userMessage?.content).toContain("What's in this image?");
  expect(userMessage?.content).toContain('Attached file: upload.png');
  expect(userMessage?.content).not.toContain('[MediaContext]');
  expect(userMessage?.content).not.toContain('ImageMediaPaths:');
});
