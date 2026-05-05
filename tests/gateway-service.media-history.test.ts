import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
    '../src/gateway/gateway-chat-service.ts'
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

test('getGatewayHistory omits silent message-send placeholders', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sessionId = 'web:silent-history';
  memoryService.getOrCreateSession(sessionId, null, 'web');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'Send that update for me.',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: '__MESSAGE_SEND_HANDLED__',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Visible follow-up __MESSAGE_SEND_HANDLED__',
  });

  const history = getGatewayHistory(sessionId, 10).history;

  expect(history).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'Send that update for me.',
    }),
    expect.objectContaining({
      role: 'assistant',
      content: 'Visible follow-up',
    }),
  ]);
});

test('getGatewayHistory returns assistant presentation per stored message agent', async () => {
  setupHome();

  const { initDatabase, upsertAgent } = await import('../src/memory/db.ts');
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });
  const mainAvatarPath = path.join(
    agentWorkspaceDir('main'),
    'assets',
    'main.png',
  );
  fs.mkdirSync(path.dirname(mainAvatarPath), { recursive: true });
  fs.writeFileSync(mainAvatarPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  upsertAgent({
    id: 'main',
    name: 'Main Agent',
    imageAsset: 'assets/main.png',
  });

  const sessionId = 'web:agent-history';
  memoryService.getOrCreateSession(sessionId, null, 'web');
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Main answer',
    agentId: 'main',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Charly answer',
    agentId: 'charly',
  });

  const history = getGatewayHistory(sessionId, 10).history;

  const mainAnswer = history.find(
    (message) => message.content === 'Main answer',
  );
  const charlyAnswer = history.find(
    (message) => message.content === 'Charly answer',
  );

  expect(mainAnswer).toMatchObject({
    role: 'assistant',
    agent_id: 'main',
    assistantPresentation: {
      agentId: 'main',
      displayName: 'Main Agent',
      imageUrl: '/api/agent-avatar?agentId=main',
    },
  });
  expect(charlyAnswer).toMatchObject({
    role: 'assistant',
    agent_id: 'charly',
    assistantPresentation: {
      agentId: 'charly',
      displayName: 'charly',
    },
  });
});

test('getGatewayHistory omits stored approval request messages', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sessionId = 'web:approval-history';
  memoryService.getOrCreateSession(sessionId, null, 'web');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'Fetch example.com',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: [
      'I need your approval before I access example.com.',
      'Why: this would contact a new external host',
      'Approval ID: be89b4bc',
      'Reply `yes` to approve once.',
      'Reply `yes for session` to trust this action for this session.',
      'Reply `yes for agent` to trust it for this agent.',
      'Reply `no` to deny.',
      'Approval expires in 120s.',
    ].join('\n'),
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: [
      'Approval needed for: access example.com',
      'Why: this would contact a new external host',
      'Approval ID: be89b4bc',
    ].join('\n'),
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Summary without contacting the host.',
  });

  const history = getGatewayHistory(sessionId, 10).history;

  expect(history).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'Fetch example.com',
    }),
    expect.objectContaining({
      role: 'assistant',
      content: 'Summary without contacting the host.',
    }),
  ]);
});

test('getGatewayHistory reconstructs branch families for reload-safe paging', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sourceSessionId = 'web:branch-source';
  memoryService.getOrCreateSession(sourceSessionId, null, 'web');
  memoryService.storeMessage({
    sessionId: sourceSessionId,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'Hoho!',
  });
  memoryService.storeMessage({
    sessionId: sourceSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'First reply',
  });
  const editedPromptId = memoryService.storeMessage({
    sessionId: sourceSessionId,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'Hoho!',
  });
  memoryService.storeMessage({
    sessionId: sourceSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Original branch reply',
  });

  const fork = memoryService.forkSessionBranch({
    sessionId: sourceSessionId,
    beforeMessageId: editedPromptId,
  });
  const branchSessionId = fork.session.id;
  const branchPromptId = memoryService.storeMessage({
    sessionId: branchSessionId,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'Hoho! AHA',
  });
  memoryService.storeMessage({
    sessionId: branchSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Edited branch reply',
  });

  expect(getGatewayHistory(sourceSessionId, 10).branchFamilies).toEqual([
    {
      anchorSessionId: sourceSessionId,
      anchorMessageId: editedPromptId,
      variants: [
        {
          sessionId: sourceSessionId,
          messageId: editedPromptId,
        },
        {
          sessionId: branchSessionId,
          messageId: branchPromptId,
        },
      ],
    },
  ]);
  expect(getGatewayHistory(branchSessionId, 10).branchFamilies).toEqual([
    {
      anchorSessionId: sourceSessionId,
      anchorMessageId: editedPromptId,
      variants: [
        {
          sessionId: sourceSessionId,
          messageId: editedPromptId,
        },
        {
          sessionId: branchSessionId,
          messageId: branchPromptId,
        },
      ],
    },
  ]);
});

test('getGatewayHistory tolerates databases without session_branches', async () => {
  setupHome();

  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-history-compat-')),
    'history.db',
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true, dbPath });
  memoryService.getOrCreateSession('web:no-branches-table', null, 'web');
  memoryService.storeMessage({
    sessionId: 'web:no-branches-table',
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'hello',
  });

  const directDb = new Database(dbPath);
  directDb.exec('DROP TABLE session_branches;');
  directDb.close();

  expect(() => getGatewayHistory('web:no-branches-table', 10)).not.toThrow();
  expect(getGatewayHistory('web:no-branches-table', 10).branchFamilies).toEqual(
    [],
  );
});

test('history and context usage resolve session keys to the current session', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayHistory, getGatewaySessionContextUsage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const session = memoryService.getOrCreateSession(
    'web:session-key-context',
    null,
    'web',
    'main',
  );
  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'hello',
  });

  const history = getGatewayHistory(session.session_key, 10);
  const context = getGatewaySessionContextUsage(session.session_key);

  expect(history.sessionId).toBe(session.id);
  expect(context).toMatchObject({
    status: 'ok',
    sessionId: session.id,
    snapshot: expect.objectContaining({
      sessionId: session.id,
      messageCount: 1,
    }),
  });
});

test('forkSessionBranch recreates session_branches when missing', async () => {
  setupHome();

  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-branch-compat-')),
    'branch.db',
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true, dbPath });
  const sessionId = 'web:branch-no-table';
  memoryService.getOrCreateSession(sessionId, null, 'web');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'web',
    role: 'user',
    content: 'Original',
  });
  const messageId = memoryService.storeMessage({
    sessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'Reply',
  });

  const directDb = new Database(dbPath);
  directDb.exec('DROP TABLE session_branches;');
  directDb.close();

  expect(() =>
    memoryService.forkSessionBranch({
      sessionId,
      beforeMessageId: messageId,
    }),
  ).not.toThrow();
});
