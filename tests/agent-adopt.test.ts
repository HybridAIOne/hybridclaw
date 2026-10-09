import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({ tempHomePrefix: 'agent-adopt-' });

const OLD = 'main-0123456789abcdef0123456789abcdef-main';
const NEW = 'main-0123456789abcdef0123456789abcdef-hy-0123456789ab';

async function setup() {
  setupHome();
  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', markdown: { 'IDENTITY.md': '# Hy\n' } }),
  ]);
  const db = await import('../src/memory/db.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { ensureBootstrapFiles, isBootstrapping } = await import(
    '../src/workspace.ts'
  );
  ensureBootstrapFiles('main');
  const main = agentWorkspaceDir('main');
  const hy = agentWorkspaceDir('hy');
  const { adoptAgent } = await import('../src/agents/agent-adopt.ts');
  return {
    db,
    main,
    hy,
    adoptAgent,
    isBootstrapping,
    handleAgentPackageCommand,
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function useMain(ctx: Ctx) {
  const session = ctx.db.getOrCreateSession(OLD, null, 'web', 'main');
  ctx.db.storeMessage(session.id, 'user_a', 'A', 'user', 'remember the milk');
  ctx.db.storeMessage(session.id, 'main', 'Hy', 'assistant', 'noted', 'main');
  fs.writeFileSync(path.join(ctx.main, 'USER.md'), '# USER.md\n\nName: A\n');
  fs.writeFileSync(path.join(ctx.main, 'MEMORY.md'), '# Memory\n\nmilk\n');
  fs.mkdirSync(path.join(ctx.main, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ctx.main, 'notes', 'list.md'), 'eggs\n');
  return session;
}

function row<T>(ctx: Ctx, sql: string, ...params: unknown[]): T | undefined {
  return ctx.db.withMemoryDatabase(
    (database) => database.prepare(sql).get(...params) as T | undefined,
  );
}

test('adopt moves the phone thread, its task and memory and ends onboarding', async () => {
  const ctx = await setup();
  const session = useMain(ctx);
  const { createJob } = await import('../src/memory/jobs.ts');
  const taskId = createJob({
    kind: 'scheduled_task',
    sessionId: session.id,
    channelId: 'web',
    cronExpr: '0 9 * * *',
    prompt: 'check the milk',
  });
  ctx.db.setMemoryValue('main', 'preference', 'oat');
  ctx.db.setMemoryValue(session.id, 'gateway.activeAgent:' + OLD, 'main');
  ctx.db.setMemoryValue('gateway.bootstrap_autostart.workspace.v1', 'gateway.bootstrap_autostart.v1.hy.BOOTSTRAP.md.x', { status: 'done' });
  ctx.db.appendCanonicalMessages({
    agentId: 'main',
    userId: 'user_a',
    newMessages: [{ role: 'user', content: 'hi', sessionId: session.id }],
  });
  const { DATA_DIR } = await import('../src/config/config.ts');
  fs.mkdirSync(path.join(DATA_DIR, 'sessions', OLD), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'sessions', OLD, 'state.json'), '{}');
  const { archiveTranscript } = await import(
    '../src/memory/compaction-archive.ts'
  );
  const archive = archiveTranscript({ sessionId: OLD, messages: [] });
  const notifications = await import('../src/gateway/web-notification-store.ts');
  notifications.bindWebNotificationSession(OLD, 'operator', 'hy');
  expect(ctx.isBootstrapping('hy')).toBe(true);

  const result = await ctx.adoptAgent({
    to: 'hy',
    sessions: [{ from: OLD, to: NEW }],
  });

  expect(result).toMatchObject({
    status: 'adopted',
    from: 'main',
    to: 'hy',
    sessionsMoved: 1,
    threadsRenamed: 1,
    movedAside: [],
  });
  expect(ctx.db.getSessionById(OLD)).toBeUndefined();
  const moved = ctx.db.getSessionById(NEW);
  expect(moved).toMatchObject({ agent_id: 'hy', session_key: NEW });
  expect(
    ctx.db.getConversationHistory(NEW, 10).map((message) => message.content),
  ).toEqual(expect.arrayContaining(['remember the milk', 'noted']));
  expect(
    row<{ session_id: string }>(ctx, 'SELECT session_id FROM jobs WHERE legacy_task_id = ?', taskId),
  ).toEqual({ session_id: NEW });
  expect(ctx.db.getMemoryValue('hy', 'preference')).toBe('oat');
  expect(ctx.db.getMemoryValue('main', 'preference')).toBeNull();
  expect(ctx.db.getMemoryValue(NEW, 'gateway.activeAgent:' + NEW)).toBe('hy');
  expect(
    ctx.db.getCanonicalContext({ agentId: 'hy', userId: 'user_a' }).recent_messages,
  ).toHaveLength(1);
  expect(
    ctx.db.listMemoryValues('gateway.bootstrap_autostart.workspace.v1'),
  ).toEqual([]);
  expect(fs.existsSync(path.join(DATA_DIR, 'sessions', NEW, 'state.json'))).toBe(true);
  expect(fs.readdirSync(path.join(DATA_DIR, 'compaction-archives', NEW))).toEqual([
    path.basename(archive.path),
  ]);
  expect(notifications.webNotificationSessionOperator(NEW)).toBe('operator');

  expect(fs.readFileSync(path.join(ctx.hy, 'USER.md'), 'utf8')).toContain('Name: A');
  expect(fs.readFileSync(path.join(ctx.hy, 'notes', 'list.md'), 'utf8')).toBe('eggs\n');
  expect(fs.readFileSync(path.join(ctx.hy, 'IDENTITY.md'), 'utf8')).toBe('# Hy\n');
  expect(fs.existsSync(path.join(ctx.main, 'notes', 'list.md'))).toBe(true);
  expect(fs.existsSync(path.join(ctx.hy, 'BOOTSTRAP.md'))).toBe(false);
  expect(ctx.isBootstrapping('hy')).toBe(false);
  const state = JSON.parse(
    fs.readFileSync(path.join(ctx.hy, '.hybridclaw', 'workspace-state.json'), 'utf8'),
  );
  expect(state.onboardingCompletedAt).toEqual(expect.any(String));
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  expect(getRuntimeConfig().agents.defaultAgentId).toBe('hy');

  // A later `agent config` does not bring onboarding back.
  await ctx.handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', markdown: { 'BOOTSTRAP.md': '# hatch\n' } }),
  ]);
  expect(fs.existsSync(path.join(ctx.hy, 'BOOTSTRAP.md'))).toBe(false);
  expect(ctx.isBootstrapping('hy')).toBe(false);

  expect(
    await ctx.adoptAgent({ to: 'hy', sessions: [{ from: OLD, to: NEW }] }),
  ).toEqual({ status: 'already', from: 'main', to: 'hy' });
  await ctx.handleAgentPackageCommand(['config', JSON.stringify({ id: 'writer' })]);
  await expect(ctx.adoptAgent({ to: 'hy', from: 'writer' })).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('already imported from "main"; reset it first'),
  });
});

test('an unused main leaves a new agent untouched', async () => {
  const ctx = await setup();
  ctx.db.getOrCreateSession(OLD, null, 'web', 'main');
  expect(await ctx.adoptAgent({ to: 'hy' })).toEqual({
    status: 'nothing',
    from: 'main',
    to: 'hy',
  });
  expect(ctx.db.getSessionById(OLD)?.agent_id).toBe('main');
  expect(ctx.isBootstrapping('hy')).toBe(true);
  expect(fs.existsSync(path.join(ctx.hy, '.hybridclaw', 'adopted-from.json'))).toBe(false);
});

test('a thread the user already had with the new agent is kept aside, memory merged', async () => {
  const ctx = await setup();
  useMain(ctx);
  const existing = ctx.db.getOrCreateSession(NEW, null, 'web', 'hy');
  ctx.db.storeMessage(existing.id, 'user_a', 'A', 'user', 'hello hy');
  fs.writeFileSync(path.join(ctx.hy, 'MEMORY.md'), '# Memory\n\nlikes tea\n');

  const result = await ctx.adoptAgent({
    to: 'hy',
    sessions: [{ from: OLD, to: NEW }],
  });

  expect(result.status).toBe('adopted');
  const aside = result.status === 'adopted' ? result.movedAside : [];
  expect(aside).toHaveLength(1);
  expect(aside[0]?.from).toBe(NEW);
  expect(aside[0]?.to).toMatch(new RegExp(`^${NEW}-before-adopt-\\d+$`));
  const kept = ctx.db.getSessionById(aside[0]?.to ?? '');
  expect(kept?.agent_id).toBe('hy');
  expect(
    ctx.db.getConversationHistory(kept?.id ?? '', 10).map((m) => m.content),
  ).toEqual(['hello hy']);
  expect(
    ctx.db.getConversationHistory(NEW, 10).map((m) => m.content),
  ).toContain('remember the milk');
  const memory = fs.readFileSync(path.join(ctx.hy, 'MEMORY.md'), 'utf8');
  expect(memory).toMatch(/milk[\s\S]*## Before the import from main[\s\S]*likes tea/);
});

test('refuses main as target, unknown sources and busy agents without changes', async () => {
  const ctx = await setup();
  const session = useMain(ctx);
  await expect(ctx.adoptAgent({ to: 'main', from: 'hy' })).rejects.toMatchObject({ status: 400 });
  await expect(ctx.adoptAgent({ to: 'hy', from: 'ghost' })).rejects.toMatchObject({ status: 400 });
  const executor = await import('../src/agent/executor.ts');
  vi.spyOn(executor, 'getInFlightExecutorSessionIds').mockReturnValue([session.id]);
  await expect(
    ctx.adoptAgent({ to: 'hy', sessions: [{ from: OLD, to: NEW }] }),
  ).rejects.toMatchObject({ status: 409 });
  expect(ctx.db.getSessionById(OLD)?.agent_id).toBe('main');
  expect(fs.existsSync(path.join(ctx.hy, 'notes'))).toBe(false);
});

test.each([
  {},
  { confirmation: 'RESET AGENT' },
  { confirmation: 'ADOPT AGENT', sessions: [{ from: OLD }] },
])('route requires a valid confirmation and body: %j', async (body) => {
  const ctx = await setup();
  useMain(ctx);
  const { handleAgentAdoptRoute } = await import('../src/gateway/agent-reset-route.ts');
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    headers: {},
  });
  const res = { status: 0, writeHead(status: number) { this.status = status; }, end() {} };
  expect(await handleAgentAdoptRoute(req as never, res as never, '/api/admin/agents/hy/adopt')).toBe(true);
  expect(res.status).toBe(400);
  expect(ctx.db.getSessionById(OLD)?.agent_id).toBe('main');
});

test('route restarts the gateway after an import, and only then', async () => {
  const scheduleGatewayRestart = vi.fn(() => ({ requested: true, reason: null }));
  vi.doMock('../src/gateway/gateway-restart.js', () => ({ scheduleGatewayRestart }));
  const ctx = await setup();
  useMain(ctx);
  const { handleAgentAdoptRoute } = await import('../src/gateway/agent-reset-route.ts');
  async function post() {
    const req = Object.assign(
      Readable.from([
        Buffer.from(
          JSON.stringify({
            confirmation: 'ADOPT AGENT',
            from: 'main',
            sessions: [{ from: OLD, to: NEW }],
          }),
        ),
      ]),
      { method: 'POST', headers: {} },
    );
    let body = '';
    const res = {
      status: 0,
      writeHead(status: number) {
        this.status = status;
      },
      end(chunk?: string) {
        body = chunk ?? '';
      },
    };
    await handleAgentAdoptRoute(req as never, res as never, '/api/admin/agents/hy/adopt');
    return { status: res.status, json: JSON.parse(body) };
  }
  const first = await post();
  expect(first.status).toBe(200);
  expect(first.json).toMatchObject({ status: 'adopted', gatewayRestart: 'requested' });
  expect(scheduleGatewayRestart).toHaveBeenCalledTimes(1);
  const again = await post();
  expect(again.json.status).toBe('already');
  expect(again.json.gatewayRestart).toBeUndefined();
  expect(scheduleGatewayRestart).toHaveBeenCalledTimes(1);
  vi.doUnmock('../src/gateway/gateway-restart.js');
});

test('CLI confirms, sends the contract body and prints one JSON line', async () => {
  const ctx = await setup();
  await expect(ctx.handleAgentPackageCommand(['adopt', 'hy'])).rejects.toThrow('interactive');
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: 'nothing', from: 'main', to: 'hy' })),
  );
  vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await ctx.handleAgentPackageCommand(['adopt', 'hy', '--session', `${OLD}=${NEW}`, '--yes']);
  expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/admin\/agents\/hy\/adopt$/);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    confirmation: 'ADOPT AGENT',
    sessions: [{ from: OLD, to: NEW }],
  });
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
    status: 'nothing',
    from: 'main',
    to: 'hy',
  });
  const { resolveAdminRbacAction } = await import('../src/security/admin-rbac.ts');
  expect(resolveAdminRbacAction('/api/admin/agents/hy/adopt', 'POST')).toBe('admin.agents.delete');
});

test('reset after adopt clears the marker', async () => {
  const ctx = await setup();
  useMain(ctx);
  await ctx.adoptAgent({ to: 'hy' });
  const reset = await import('../src/agents/agent-reset.ts');
  reset.saveAgentDefaults(JSON.stringify({ id: 'hy', markdown: { 'IDENTITY.md': '# Hy\n' } }));
  await reset.resetAgent('hy');
  expect(fs.existsSync(path.join(ctx.hy, '.hybridclaw', 'adopted-from.json'))).toBe(false);
});
