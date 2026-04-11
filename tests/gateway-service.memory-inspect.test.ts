import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-memory-inspect-',
});

test('memory inspect reports the built-in memory layers for the current session', async () => {
  setupHome();

  const { currentDateStampInTimezone } = await import(
    '../container/shared/workspace-time.js'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand, resolveCanonicalContextScope } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const session = memoryService.getOrCreateSession(
    'session-memory-inspect',
    null,
    'web',
    'main',
  );
  const canonicalScope = resolveCanonicalContextScope(session);
  const workspacePath = agentWorkspaceDir('main');
  fs.mkdirSync(path.join(workspacePath, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, '.session-transcripts'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspacePath, 'MEMORY.md'),
    '# MEMORY.md - Session Memory\n\nFavorite deploy note: keep it short.\n',
  );
  const todayMemoryFile = path.join(
    workspacePath,
    'memory',
    `${currentDateStampInTimezone(undefined)}.md`,
  );
  fs.writeFileSync(
    todayMemoryFile,
    'Today note: reproduced the issue and captured the fix plan.\n',
  );
  fs.writeFileSync(
    path.join(
      workspacePath,
      '.session-transcripts',
      'session-memory-inspect.jsonl',
    ),
    [
      JSON.stringify({
        sessionId: 'session-memory-inspect',
        role: 'user',
        content: 'Render the deploy animation',
      }),
      JSON.stringify({
        sessionId: 'session-memory-inspect',
        role: 'assistant',
        content: 'I can render it after the assets are in place.',
      }),
    ].join('\n'),
  );

  memoryService.storeTurn({
    sessionId: session.id,
    user: {
      userId: 'user-1',
      username: 'alice',
      content: 'Render the deploy animation',
    },
    assistant: {
      userId: 'assistant',
      username: null,
      content: 'I can render it after the assets are in place.',
    },
  });
  memoryService.updateSessionSummary(
    session.id,
    'Earlier turns covered the deploy animation plan and pending asset work.',
  );
  memoryService.markSessionMemoryFlush(session.id);
  memoryService.appendCanonicalMessages({
    agentId: 'main',
    userId: canonicalScope,
    newMessages: [
      {
        role: 'user',
        content: 'Remember the deploy checklist from yesterday.',
        sessionId: 'other-session',
        channelId: 'discord:dm',
      },
      {
        role: 'assistant',
        content: 'Stored the deploy checklist context for later reuse.',
        sessionId: 'other-session',
        channelId: 'discord:dm',
      },
    ],
  });

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['memory', 'inspect'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Memory Inspection');
  expect(result.text).toContain('Session: session-memory-inspect');
  expect(result.text).toContain('1. Workspace memory file (`MEMORY.md`)');
  expect(result.text).toContain('Favorite deploy note: keep it short.');
  expect(result.text).toContain('2. Workspace daily note for today');
  expect(result.text).toContain(
    'Today note: reproduced the issue and captured the fix plan.',
  );
  expect(result.text).toContain('3. Raw session history');
  expect(result.text).toContain('Render the deploy animation');
  expect(result.text).toContain('4. Compacted session summary');
  expect(result.text).toContain(
    'Earlier turns covered the deploy animation plan and pending asset work.',
  );
  expect(result.text).toContain('5. Semantic memory store');
  expect(result.text).toContain(
    'User asked: Render the deploy animation I responded: I can render it after the assets are in place.',
  );
  expect(result.text).toContain('6. Canonical cross-channel memory');
  expect(result.text).toContain(
    'Remember the deploy checklist from yesterday.',
  );
});

test('memory inspect rejects remote sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-memory-inspect-remote',
    guildId: 'guild-1',
    channelId: 'discord:channel-1',
    args: ['memory', 'inspect'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Memory Commands Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('memory query previews the attached prompt block without mutating recall access metadata', async () => {
  setupHome();

  const { initDatabase, listSemanticMemoriesForSession } = await import(
    '../src/memory/db.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const session = memoryService.getOrCreateSession(
    'session-memory-query',
    null,
    'web',
    'main',
  );
  memoryService.storeTurn({
    sessionId: session.id,
    user: {
      userId: 'user-1',
      username: 'alice',
      content: 'Render the deploy animation',
    },
    assistant: {
      userId: 'assistant',
      username: null,
      content: 'I can render it after the assets are in place.',
    },
  });
  memoryService.updateSessionSummary(
    session.id,
    'Earlier turns covered the deploy animation plan and pending asset work.',
  );

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['memory', 'query', 'deploy', 'animation'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Memory Query');
  expect(result.text).toContain('Query: deploy animation');
  expect(result.text).toContain(
    'Mode: read-only diagnostic (matches prompt assembly without updating semantic recall access metadata)',
  );
  expect(result.text).toContain('Summary included: yes');
  expect(result.text).toContain('Matched semantic memories:');
  expect(result.text).toContain('Exact attached block:');
  expect(result.text).toContain('Relevant Memory Recall');
  expect(result.text).toContain(
    'Earlier turns covered the deploy animation plan and pending asset work.',
  );
  expect(result.text).toContain('Render the deploy animation');

  const memories = listSemanticMemoriesForSession(session.id, 5);
  expect(memories[0]?.access_count).toBe(0);
});
