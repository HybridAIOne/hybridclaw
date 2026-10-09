import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({ tempHomePrefix: 'hybridclaw-scopes-' });

function request(method: string, body?: unknown): IncomingMessage {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage;
  req.method = method;
  return req;
}

function response() {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    writeHead(status: number) {
      res.statusCode = status;
      return res;
    },
    end(chunk?: string) {
      res.body = chunk ?? '';
    },
  };
  return res;
}

async function setup() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const routes = await import('../src/scopes/scope-routes.js');
  const call = async (method: string, pathAndQuery: string, body?: unknown) => {
    const res = response();
    await routes.handleScopesRoute(
      request(method, body),
      res as unknown as ServerResponse,
      new URL(pathAndQuery, 'http://gateway.test'),
    );
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
  return { db, call };
}

test('scopes are created, listed, renamed, changed and deleted per agent', async () => {
  const { call } = await setup();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');

  const created = await call('POST', '/api/scopes', {
    agentId: 'main',
    name: '  Work  ',
    connectors: ['Google', 'device', 'google'],
  });
  expect(created.status).toBe(201);
  expect(created.body).toEqual({
    id: expect.stringMatching(/^s_[0-9a-f]{12}$/),
    name: 'Work',
    connectors: ['google', 'device'],
    createdAt: expect.any(String),
  });
  const id = created.body.id as string;

  expect((await call('GET', '/api/scopes?agentId=main')).body).toEqual({
    scopes: [created.body],
  });

  const renamed = await call('PATCH', `/api/scopes/${id}`, {
    agentId: 'main',
    name: 'Office',
  });
  expect(renamed.body).toMatchObject({ id, name: 'Office' });
  const rewired = await call('PATCH', `/api/scopes/${id}`, {
    agentId: 'main',
    connectors: [],
  });
  expect(rewired.body).toMatchObject({ name: 'Office', connectors: [] });

  const scopeDir = path.join(agentWorkspaceDir('main'), 'scopes', id);
  fs.mkdirSync(path.join(scopeDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'MEMORY.md'), '- A note.\n');
  expect(
    (await call('DELETE', `/api/scopes/${id}?agentId=main`)).body,
  ).toEqual({ deleted: true });
  expect(fs.existsSync(scopeDir)).toBe(false);
  expect((await call('GET', '/api/scopes?agentId=main')).body.scopes).toEqual(
    [],
  );
  expect((await call('DELETE', `/api/scopes/${id}?agentId=main`)).status).toBe(
    404,
  );
});

test('scope names are checked and unique per agent, ignoring case', async () => {
  const { call } = await setup();
  await call('POST', '/api/scopes', { agentId: 'main', name: 'Work' });

  const duplicate = await call('POST', '/api/scopes', {
    agentId: 'main',
    name: 'WORK',
    connectors: [],
  });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.errorCode).toBe('scope_exists');

  for (const name of ['', '   ', 'x'.repeat(41), 42]) {
    const invalid = await call('POST', '/api/scopes', {
      agentId: 'main',
      name,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errorCode).toBe('invalid_scope');
  }
  expect(
    (
      await call('POST', '/api/scopes', {
        agentId: 'main',
        name: 'Family',
        connectors: ['../etc'],
      })
    ).body.errorCode,
  ).toBe('invalid_scope');
  expect(
    (await call('POST', '/api/scopes', { agentId: 'nobody', name: 'Home' }))
      .body.errorCode,
  ).toBe('unknown_agent');
  expect((await call('PUT', '/api/scopes')).status).toBe(400);
});

test('scopes go with chatting: phone tokens manage them, the agent runtime cannot', async () => {
  const { resolveAdminRbacAction, isAdminActionAllowed } = await import(
    '../src/security/admin-rbac.js'
  );
  const { AGENT_RUNTIME_TOKEN_CLAIMS } = await import(
    '../src/security/agent-runtime-token.js'
  );
  for (const [pathname, method] of [
    ['/api/scopes', 'GET'],
    ['/api/scopes', 'POST'],
    ['/api/scopes/s_0123456789ab', 'PATCH'],
    ['/api/scopes/s_0123456789ab', 'DELETE'],
  ]) {
    const action = resolveAdminRbacAction(pathname, method);
    expect(action).toBe('chat.send');
    expect(
      isAdminActionAllowed({ actions: ['chat.send'] }, action ?? 'chat.send'),
    ).toBe(true);
    expect(
      isAdminActionAllowed(AGENT_RUNTIME_TOKEN_CLAIMS, action ?? 'chat.send'),
    ).toBe(false);
  }
});

test('a new chat takes its first scope for good; unknown scopes are refused', async () => {
  const { db, call } = await setup();
  const { bindRequestedScope } = await import('../src/scopes/scope-session.js');
  const work = (await call('POST', '/api/scopes', { agentId: 'main', name: 'Work' }))
    .body.id as string;
  const family = (
    await call('POST', '/api/scopes', { agentId: 'main', name: 'Family' })
  ).body.id as string;
  const bind = (sessionId: string, requestedScope: unknown) =>
    bindRequestedScope({
      sessionId,
      guildId: null,
      channelId: 'web',
      agentId: 'main',
      requestedScope,
    });

  // Commands the app sends before the first message create the session.
  expect(bind('ios-side-a', work)).toBeNull();
  expect(db.getSessionById('ios-side-a')?.scope).toBe(work);
  expect(bind('ios-side-a', family)).toBeNull();
  expect(db.getSessionById('ios-side-a')?.scope).toBe(work);

  expect(bind('ios-side-b', 's_ffffffffffff')).toEqual({
    errorCode: 'unknown_scope',
    error: expect.any(String),
  });
  expect(bind('ios-side-b', '../work')).toMatchObject({
    errorCode: 'unknown_scope',
  });
  expect(db.getSessionById('ios-side-b')).toBeUndefined();

  // A chat that already had a turn without a scope keeps none.
  db.getOrCreateSession('ios-side-c', null, 'web', 'main');
  db.storeMessage('ios-side-c', 'user_a', 'user_a', 'user', 'Hello');
  expect(bind('ios-side-c', work)).toBeNull();
  expect(db.getSessionById('ios-side-c')?.scope ?? null).toBeNull();

  // The main chat is never scoped.
  expect(bind('main-0123456789abcdef-hy', work)).toBeNull();
  expect(db.getSessionById('main-0123456789abcdef-hy')?.scope ?? null).toBeNull();
});

test('reset and branch keep the chat in its scope', async () => {
  const { db, call } = await setup();
  const { bindRequestedScope } = await import('../src/scopes/scope-session.js');
  const work = (await call('POST', '/api/scopes', { agentId: 'main', name: 'Work' }))
    .body.id as string;
  bindRequestedScope({
    sessionId: 'ios-side',
    guildId: null,
    channelId: 'web',
    agentId: 'main',
    requestedScope: work,
  });
  const messageId = db.storeMessage('ios-side', 'user_a', 'user_a', 'user', 'First');
  db.storeMessage('ios-side', 'assistant', null, 'assistant', 'Reply');

  const branch = db.forkSessionBranch({
    sessionId: 'ios-side',
    beforeMessageId: messageId + 1,
  });
  expect(branch.session.scope).toBe(work);
  const reset = db.createFreshSessionInstance('ios-side', {
    resetSettings: true,
  });
  expect(reset.session.scope).toBe(work);
});

test("a scope's connectors are all a scoped chat keeps; it fails closed", async () => {
  const { scopeBlockedTools, parseConnectorDirectory } = await import(
    '../src/scopes/scope-connectors.js'
  );
  const directory = parseConnectorDirectory({
    connectors: [
      { id: 'google', kind: 'connector' },
      { id: 'microsoft365', kind: 'connector' },
      { id: 'mailbox' },
      { id: 'dm', kind: 'tool' },
    ],
  });

  expect(scopeBlockedTools({ connectors: ['google'] }, directory)).toEqual([
    'device_data',
    'hybridai__*__*',
    '!hybridai__dm__*',
    '!hybridai__google__*',
    '!hybridai__google_workspace__*',
  ]);
  expect(scopeBlockedTools({ connectors: ['device'] }, directory)).toEqual([
    'hybridai__*__*',
    '!hybridai__dm__*',
  ]);
  // Without the directory every connector service is blocked.
  expect(scopeBlockedTools({ connectors: ['google'] }, null)).toEqual([
    'device_data',
    'hybridai__*__*',
  ]);
});

test("a scope's worker acts only for its scope's chats", async () => {
  const { db, call } = await setup();
  const { bindRequestedScope } = await import('../src/scopes/scope-session.js');
  const { matchScopeRuntimeToken, scopedRuntimeRequestError } = await import(
    '../src/scopes/scope-runtime-auth.js'
  );
  const { deriveScopeRuntimeToken, deriveAgentRuntimeToken } = await import(
    '../src/security/agent-runtime-token.js'
  );
  const work = (await call('POST', '/api/scopes', { agentId: 'main', name: 'Work' }))
    .body.id as string;
  bindRequestedScope({
    sessionId: 'ios-work',
    guildId: null,
    channelId: 'web',
    agentId: 'main',
    requestedScope: work,
  });
  db.getOrCreateSession('main-0123456789abcdef-hy', null, 'web', 'main');

  const token = deriveScopeRuntimeToken('gateway-secret', 'main', work);
  expect(matchScopeRuntimeToken(token, 'gateway-secret')).toEqual({
    agentId: 'main',
    scopeId: work,
  });
  expect(
    matchScopeRuntimeToken(deriveAgentRuntimeToken('gateway-secret'), 'gateway-secret'),
  ).toBeNull();

  const scope = { agentId: 'main', scopeId: work };
  const check = (pathname: string, body: unknown) =>
    scopedRuntimeRequestError({
      req: request('POST', body),
      pathname,
      scope,
      memoryToolNames: ['memory_recall'],
    });
  expect(await check('/api/todo', { sessionId: 'ios-work' })).toBeNull();
  expect(
    await check('/api/todo', { sessionId: 'main-0123456789abcdef-hy' }),
  ).toMatch(/only for chats of its scope/);
  expect(await check('/api/delegate', { sessionId: 'unknown' })).toMatch(
    /only for chats of its scope/,
  );
  expect(await check('/api/scheduler/task', { action: 'list' })).toMatch(
    /only for chats of its scope/,
  );
  expect(await check('/api/cost-estimate', { steps: 3 })).toBeNull();
  expect(await check('/api/notes/runtime', { sessionId: 'ios-work' })).toMatch(
    /Not available/,
  );
  expect(
    await check('/api/plugin/tool', {
      sessionId: 'ios-work',
      toolName: 'memory_recall',
    }),
  ).toMatch(/Not available/);
});

test("a scoped chat sees only its scope's chats; the main chat sees all", async () => {
  const { db, call } = await setup();
  const { bindRequestedScope } = await import('../src/scopes/scope-session.js');
  const { canSeeSession, listManageableScheduledTasks } = await import(
    '../src/gateway/scheduled-task-access.js'
  );
  const work = (await call('POST', '/api/scopes', { agentId: 'main', name: 'Work' }))
    .body.id as string;
  for (const sessionId of ['ios-work-a', 'ios-work-b']) {
    bindRequestedScope({
      sessionId,
      guildId: null,
      channelId: 'web',
      agentId: 'main',
      requestedScope: work,
    });
  }
  db.getOrCreateSession('main-0123456789abcdef-hy', null, 'web', 'main');
  const workA = db.getSessionById('ios-work-a')!;
  const main = db.getSessionById('main-0123456789abcdef-hy')!;

  expect(canSeeSession('ios-work-b', workA)).toBe(true);
  expect(canSeeSession(main.id, workA)).toBe(false);
  expect(canSeeSession(workA.id, main)).toBe(true);
  expect(listManageableScheduledTasks(workA).hiddenCount).toBe(0);
});
