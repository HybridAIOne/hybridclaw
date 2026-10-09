import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { currentDateStampInTimezone } from '../container/shared/workspace-time.js';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import type { ContainerOutput } from '../src/types/container.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-scoped-turn-',
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
const TIMEZONE = 'Europe/Berlin';

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function promptText(request: ExecutorRequest): string {
  return request.messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    )
    .join('\n');
}

// An agent with memory of its own, a "Work" scope and a "Family" scope.
async function setup() {
  setupHome();
  // The connector directory is out of reach: scoped chats fail closed.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const workspace = await import('../src/workspace.js');
  const { createScope } = await import('../src/scopes/scope-store.js');
  const { bindRequestedScope } = await import('../src/scopes/scope-session.js');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );

  const agentDir = agentWorkspaceDir('main');
  workspace.ensureBootstrapFiles('main');
  fs.rmSync(path.join(agentDir, 'BOOTSTRAP.md'), { force: true });
  workspace.completeWorkspaceOnboarding('main');
  const today = currentDateStampInTimezone(TIMEZONE);
  write(
    agentDir,
    'USER.md',
    [
      '# USER.md - About Your Human',
      '',
      '- **Name:** Pat Example',
      '- **What to call them:** Pat',
      '- **Email:** pat@example.com',
      `- **Timezone:** ${TIMEZONE}`,
      '- **Notes:** Plans a surprise party on Friday.',
      '',
    ].join('\n'),
  );
  write(agentDir, 'MEMORY.md', '- Main memory: the dentist is on Friday.\n');
  write(agentDir, `memory/${today}.md`, '- Main daily: watered the garden.\n');

  const work = createScope({ agentId: 'main', name: 'Work', connectors: [] });
  const family = createScope({
    agentId: 'main',
    name: 'Family',
    connectors: [],
  });
  const workDir = path.join(agentDir, 'scopes', work.id);
  write(workDir, 'MEMORY.md', '- Work memory: the quarterly report.\n');
  write(workDir, `memory/${today}.md`, '- Work daily: sent the invoice.\n');
  write(
    path.join(agentDir, 'scopes', family.id),
    'MEMORY.md',
    '- Family memory: the school trip.\n',
  );
  runAgentMock.mockResolvedValue(SUCCESS);

  const turn = (sessionId: string, content = 'What should I do next?') =>
    handleGatewayMessage({
      sessionId,
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      username: 'web',
      agentId: 'main',
      model: 'openai-codex/gpt-5-codex',
      chatbotId: '',
      client: 'mobile',
      content,
    });
  const bind = (sessionId: string, scope: string) =>
    bindRequestedScope({
      sessionId,
      guildId: null,
      channelId: 'web',
      agentId: 'main',
      requestedScope: scope,
    });
  return { db, agentDir, work, family, workDir, turn, bind };
}

test('a scoped chat sees its scope and who the user is, nothing else', async () => {
  const { agentDir, work, workDir, turn, bind } = await setup();
  expect(bind('ios-work', work.id)).toBeNull();

  const result = await turn('ios-work');

  expect(result.status).toBe('success');
  expect(result.scope).toBe(work.id);
  const request = runAgentMock.mock.calls[0]?.[0] as ExecutorRequest;
  const prompt = promptText(request);
  expect(prompt).toContain('Work memory: the quarterly report.');
  expect(prompt).toContain('Work daily: sent the invoice.');
  expect(prompt).toContain('- **What to call them:** Pat');
  expect(prompt).toContain(`- **Timezone:** ${TIMEZONE}`);
  for (const secret of [
    'dentist',
    'garden',
    'school trip',
    'pat@example.com',
    'surprise party',
  ]) {
    expect(prompt).not.toContain(secret);
  }
  expect(request.workspacePathOverride).toBe(workDir);
  expect(request.runtimeScope).toEqual({ agentId: 'main', scopeId: work.id });
  expect(request.blockedTools).toEqual(
    expect.arrayContaining(['device_data', 'hybridai__*__*']),
  );
  expect(request.blockedTools).not.toContain('!hybridai__dm__*');
  // The scope's own USER.md holds only what the scope may know.
  const scopeUser = fs.readFileSync(path.join(workDir, 'USER.md'), 'utf-8');
  expect(scopeUser).not.toContain('pat@example.com');
  expect(fs.readFileSync(path.join(workDir, 'SOUL.md'), 'utf-8')).toBe(
    fs.readFileSync(path.join(agentDir, 'SOUL.md'), 'utf-8'),
  );
  // The turn's transcript stays in the scope.
  const transcripts = path.join(workDir, '.session-transcripts');
  expect(fs.readdirSync(transcripts).length).toBe(1);
  expect(
    fs.existsSync(path.join(agentDir, '.session-transcripts')) &&
      fs.readdirSync(path.join(agentDir, '.session-transcripts')).length > 0,
  ).toBe(false);
});

test('a later request cannot move a chat to another scope', async () => {
  const { work, family, workDir, turn, bind } = await setup();
  bind('ios-work', work.id);
  await turn('ios-work');
  expect(bind('ios-work', family.id)).toBeNull();

  const result = await turn('ios-work');

  expect(result.scope).toBe(work.id);
  const request = runAgentMock.mock.calls[1]?.[0] as ExecutorRequest;
  expect(request.workspacePathOverride).toBe(workDir);
  expect(promptText(request)).not.toContain('school trip');
});

test("the main chat keeps the agent's memory and every connector", async () => {
  const { turn } = await setup();

  const result = await turn('main-0123456789abcdef-hy');

  expect(result.scope).toBeUndefined();
  const request = runAgentMock.mock.calls[0]?.[0] as ExecutorRequest;
  expect(promptText(request)).toContain('the dentist is on Friday');
  expect(request.workspacePathOverride).toBeUndefined();
  expect(request.runtimeScope).toBeUndefined();
  expect(request.blockedTools ?? []).not.toContain('hybridai__*__*');
});

test('a chat whose scope was deleted runs nothing', async () => {
  const { work, turn, bind } = await setup();
  const { deleteScopeRow } = await import('../src/scopes/scope-store.js');
  bind('ios-work', work.id);
  deleteScopeRow('main', work.id);

  const result = await turn('ios-work');

  expect(result).toMatchObject({
    status: 'error',
    errorCode: 'scope_deleted',
    scope: work.id,
  });
  expect(runAgentMock).not.toHaveBeenCalled();
});

test('a symlinked scope directory is refused instead of mounted', async () => {
  const { agentDir, work, workDir, turn, bind } = await setup();
  bind('ios-work', work.id);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.symlinkSync(agentDir, workDir);

  await expect(turn('ios-work')).rejects.toThrow(/not where it belongs/);
  expect(runAgentMock).not.toHaveBeenCalled();
});

test("a scope's todos are its own", async () => {
  const { db, work, bind } = await setup();
  const { todoOwnerOf } = await import('../src/todos/todo-store.js');
  bind('ios-work', work.id);
  db.getOrCreateSession('ios-plain', null, 'web', 'main');

  expect(todoOwnerOf(db.getSessionById('ios-work')!)).toBe(
    `scope:main:${work.id}`,
  );
  expect(todoOwnerOf(db.getSessionById('ios-plain')!)).toBe('web:main');
});

test('the pre-compaction flush writes into the scope, from the scope', async () => {
  const { db, work, workDir, bind } = await setup();
  const { runPreCompactionMemoryFlush } = await import(
    '../src/session/session-maintenance.js'
  );
  bind('ios-work', work.id);
  db.storeMessage('ios-work', 'user_a', 'web', 'user', 'Remember the invoice.');

  await runPreCompactionMemoryFlush({
    sessionId: 'ios-work',
    agentId: 'main',
    chatbotId: '',
    enableRag: false,
    model: 'openai-codex/gpt-5-codex',
    channelId: 'web',
    sessionSummary: null,
    olderMessages: db.getRecentMessages('ios-work'),
  });

  const request = runAgentMock.mock.calls[0]?.[0] as ExecutorRequest;
  expect(request.allowedTools).toEqual(['memory']);
  expect(request.workspacePathOverride).toBe(workDir);
  expect(request.runtimeScope).toEqual({ agentId: 'main', scopeId: work.id });
  expect(promptText(request)).not.toContain('dentist');
});

test("a scoped chat's subagents work in its scope", async () => {
  const { work, workDir, bind } = await setup();
  const { runDelegationTaskWithRetry } = await import(
    '../src/gateway/delegation-child-run.js'
  );
  bind('ios-work', work.id);

  await runDelegationTaskWithRetry({
    parentSessionId: 'ios-work',
    childDepth: 1,
    channelId: 'web',
    chatbotId: '',
    enableRag: false,
    agentId: 'main',
    mode: 'single',
    task: { prompt: 'Summarize the notes.', model: 'openai-codex/gpt-5-codex' },
  });

  const request = runAgentMock.mock.calls[0]?.[0] as ExecutorRequest;
  expect(request.workspacePathOverride).toBe(workDir);
  expect(request.runtimeScope).toEqual({ agentId: 'main', scopeId: work.id });
  expect(request.blockedTools).toContain('hybridai__*__*');
});
