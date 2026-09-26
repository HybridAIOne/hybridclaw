import { expect, test, vi } from 'vitest';

import { isDynamicContextMessageText } from '../container/shared/dynamic-context.js';
import type { ChatMessage } from '../src/types/api.js';
import type { ContainerOutput, ExecutorRequest } from '../src/types/container.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-earlier-attachments-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const SUCCESS: ContainerOutput = {
  status: 'success',
  result: 'Done.',
  toolsUsed: [],
  toolExecutions: [],
};

async function setupUploadedLogo() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { createUploadedMediaContextItem } = await import(
    '../src/media/uploaded-media-cache.js'
  );
  const logo = await createUploadedMediaContextItem({
    attachmentName: 'Logo.png',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    mimeType: 'image/png',
  });
  const request = {
    sessionId: 'web:earlier-attachments',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
  };
  return { logo, request };
}

function promptOfCall(index: number): {
  dynamicContext: string;
  currentUserMessage: string;
} {
  const messages = (runAgentMock.mock.calls[index][0] as ExecutorRequest)
    .messages as ChatMessage[];
  const dynamicContext = messages.find(
    (message) =>
      message.role === 'user' && isDynamicContextMessageText(message.content),
  );
  return {
    dynamicContext: String(dynamicContext?.content ?? ''),
    currentUserMessage: String(messages.at(-1)?.content ?? ''),
  };
}

function earlierAttachmentEntries(dynamicContext: string): unknown[] {
  const section = dynamicContext.split('## Earlier Attachments\n')[1] ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

test('a follow-up turn after an upload sees the attachment path', async () => {
  const { logo, request } = await setupUploadedLogo();
  runAgentMock.mockResolvedValue(SUCCESS);
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { memoryService } = await import('../src/memory/memory-service.js');

  await handleGatewayMessage({
    ...request,
    content: 'Here is our logo.',
    media: [logo],
  });
  await handleGatewayMessage({
    ...request,
    content: 'The image should only be committed.',
  });

  expect(logo.path).toMatch(/^\/uploaded-media-cache\/.+-Logo\.png$/);
  const followUp = promptOfCall(1);
  expect(earlierAttachmentEntries(followUp.dynamicContext)).toEqual([
    {
      filename: 'Logo.png',
      mime: 'image/png',
      size: 8,
      status: 'available',
      path: logo.path,
    },
  ]);
  // Earlier paths ride in the per-turn context, not in the user's message.
  expect(followUp.currentUserMessage).toContain(
    'The image should only be committed.',
  );
  expect(followUp.currentUserMessage).not.toContain(String(logo.path));
  // The stored turn, which the UI renders, keeps the readable summary only.
  const storedUpload = memoryService
    .getConversationHistory(request.sessionId, 10)
    .find((message) => message.content.startsWith('Here is our logo.'));
  expect(storedUpload?.content).toBe(
    'Here is our logo.\n\nAttached file: Logo.png',
  );
});

function visionToolHistory(imagePath: string): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'vision-1',
          type: 'function',
          function: {
            name: 'vision_analyze',
            arguments: JSON.stringify({ image_url: imagePath }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'vision-1',
      content: 'A blue wordmark on white.',
    },
  ];
}

test.each([
  ['no tool history survives the stop', false],
  ['the stopped agent flushed its tool history', true],
])('the next turn still sees the path after an interrupted tool-using turn (%s)', async (_label, flushed) => {
  const { logo, request } = await setupUploadedLogo();
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { abortActiveGatewayRequests } = await import(
    '../src/gateway/gateway-request-runtime.js'
  );
  const { memoryService } = await import('../src/memory/memory-service.js');
  const toolHistory = visionToolHistory(String(logo.path));
  runAgentMock
    .mockImplementationOnce(
      async (params: ExecutorRequest): Promise<ContainerOutput> => {
        params.onToolProgress?.({
          sessionId: params.sessionId,
          toolName: 'vision_analyze',
          phase: 'start',
          preview: JSON.stringify({ image_url: logo.path }),
        });
        params.onToolProgress?.({
          sessionId: params.sessionId,
          toolName: 'vision_analyze',
          phase: 'finish',
          preview: 'A blue wordmark on white.',
          durationMs: 5,
        });
        abortActiveGatewayRequests(request.sessionId);
        expect(params.abortSignal?.aborted).toBe(true);
        // What the runner returns for an interrupt (see src/infra/ipc.ts).
        return {
          status: 'error',
          result: null,
          toolsUsed: [],
          error: 'Interrupted by user.',
          ...(flushed
            ? { toolHistory, toolHistoryForReplay: toolHistory }
            : {}),
        };
      },
    )
    .mockResolvedValue(SUCCESS);

  const interrupted = await handleGatewayMessage({
    ...request,
    content: 'Commit this logo to the repo.',
    media: [logo],
  });
  await handleGatewayMessage({
    ...request,
    content: 'The image should only be committed.',
  });

  expect(interrupted.status).toBe('error');
  const placeholder = memoryService
    .getConversationHistory(request.sessionId, 10)
    .find((message) => message.content.includes('Interrupted by user.'));
  expect(placeholder?.content).toContain('- vision_analyze: completed');
  expect(earlierAttachmentEntries(promptOfCall(1).dynamicContext)).toEqual([
    expect.objectContaining({ status: 'available', path: logo.path }),
  ]);
  const replayed = (runAgentMock.mock.calls[1][0] as ExecutorRequest)
    .messages as ChatMessage[];
  if (flushed) {
    expect(replayed).toEqual(expect.arrayContaining(toolHistory));
  } else {
    expect(placeholder?.tool_history_json ?? null).toBeNull();
    expect(replayed.some((message) => message.role === 'tool')).toBe(false);
  }
});

test('an attachment removed by media cleanup reads as no longer available', async () => {
  const { logo, request } = await setupUploadedLogo();
  runAgentMock.mockResolvedValue(SUCCESS);
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { cleanupUploadedMediaCache } = await import(
    '../src/media/uploaded-media-cache.js'
  );

  await handleGatewayMessage({
    ...request,
    content: 'Here is our logo.',
    media: [logo],
  });
  await cleanupUploadedMediaCache({ nowMs: Date.now() + 2 * 86_400_000 });
  await handleGatewayMessage({
    ...request,
    content: 'Commit the logo from before.',
  });

  const followUp = promptOfCall(1);
  expect(earlierAttachmentEntries(followUp.dynamicContext)).toEqual([
    {
      filename: 'Logo.png',
      mime: 'image/png',
      size: 8,
      status: 'no longer available',
    },
  ]);
  expect(followUp.dynamicContext).not.toContain(String(logo.path));
});
