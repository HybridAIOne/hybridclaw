import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({ tempHomePrefix: 'agent-reset-' });

async function setup() {
  setupHome();
  const { handleAgentPackageCommand } = await import('../src/cli/agent-command.ts');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const id of ['hy', 'writer']) {
    await handleAgentPackageCommand(['config', JSON.stringify({ id, displayName: id, markdown: { 'IDENTITY.md': `# ${id}` } }), '--activate']);
  }
  const reset = await import('../src/agents/agent-reset.ts');
  reset.saveAgentDefaults(JSON.stringify({ id: 'hy', displayName: 'Hy', model: 'gpt-6-luna', markdown: { 'IDENTITY.md': '# Hy\n' } }));
  const db = await import('../src/memory/db.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const hy = agentWorkspaceDir('hy');
  const writer = agentWorkspaceDir('writer');
  fs.writeFileSync(path.join(hy, 'private.txt'), 'delete');
  fs.writeFileSync(path.join(writer, 'private.txt'), 'keep');
  const hySession = db.getOrCreateSession('hy-session', null, 'web', 'hy');
  const writerSession = db.getOrCreateSession('writer-session', null, 'web', 'writer');
  db.setMemoryValue('hy', 'personal', 'delete');
  db.setMemoryValue('writer', 'personal', 'keep');
  return { ...reset, db, hy, writer, hySession, writerSession, handleAgentPackageCommand };
}

test('reset restores provisioned identity and removes only the chosen agent data, including archived sessions', async () => {
  const ctx = await setup();
  const rotated = ctx.db.createFreshSessionInstance(ctx.hySession.id);
  const { DATA_DIR } = await import('../src/config/config.ts');
  const sessionDir = path.join(DATA_DIR, 'sessions', ctx.hySession.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const { archiveTranscript } = await import('../src/memory/compaction-archive.ts');
  const hyArchive = archiveTranscript({ sessionId: ctx.hySession.id, messages: [] });
  const writerArchive = archiveTranscript({ sessionId: ctx.writerSession.id, messages: [] });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'transcript.json'), '{}');
  const { upsertRegisteredAgent, getAgentById } = await import('../src/agents/agent-registry.ts');
  upsertRegisteredAgent({ id: 'hy', displayName: 'Custom', tools: ['local'], skills: ['custom'] });
  upsertRegisteredAgent({ id: 'writer', reportsTo: 'hy' });
  const result = await ctx.resetAgent('hy');
  expect(getAgentById('hy')?.tools).toBeUndefined();
  expect(getAgentById('hy')?.skills).toBeUndefined();
  expect(getAgentById('writer')?.reportsTo).toBe('hy');
  expect(result.deletedSessions).toBe(2);
  expect(fs.existsSync(path.join(ctx.hy, 'private.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(ctx.hy, 'IDENTITY.md'), 'utf8')).toBe('# Hy\n');
  expect(fs.existsSync(path.join(ctx.hy, 'SOUL.md'))).toBe(true);
  expect(fs.readFileSync(path.join(ctx.writer, 'private.txt'), 'utf8')).toBe('keep');
  expect(ctx.db.getSessionById(ctx.hySession.id)).toBeUndefined();
  expect(ctx.db.getSessionById(rotated.session.id)).toBeUndefined();
  expect(ctx.db.getSessionById(ctx.writerSession.id)).not.toBeNull();
  expect(ctx.db.getMemoryValue('hy', 'personal')).toBeNull();
  expect(ctx.db.getMemoryValue('writer', 'personal')).toBe('keep');
  expect(fs.existsSync(sessionDir)).toBe(false);
  expect(fs.existsSync(hyArchive.path)).toBe(false);
  expect(fs.existsSync(writerArchive.path)).toBe(true);
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  expect(getRuntimeConfig().agents.defaultAgentId).toBe('hy');
  await ctx.resetAgent('hy');
  expect(fs.readFileSync(path.join(ctx.hy, 'IDENTITY.md'), 'utf8')).toBe('# Hy\n');
});

test('keeping history preserves sessions and tasks while replacing files', async () => {
  const ctx = await setup();
  await ctx.resetAgent('hy', false);
  expect(ctx.db.getSessionById(ctx.hySession.id)).not.toBeNull();
  expect(ctx.db.getMemoryValue('hy', 'personal')).toBe('delete');
  expect(fs.existsSync(path.join(ctx.hy, 'private.txt'))).toBe(false);
});

test('missing or invalid reset defaults fail before deleting data', async () => {
  const ctx = await setup();
  await expect(ctx.resetAgent('writer')).rejects.toThrow('No reset defaults');
  for (const input of [{ id: '../hy' }, { id: 'hy', workspace: 'writer' }, { id: 'hy', markdown: { '../evil.md': 'bad' } }]) {
    expect(() => ctx.saveAgentDefaults(JSON.stringify(input))).toThrow();
  }
  expect(fs.existsSync(path.join(ctx.hy, 'private.txt'))).toBe(true);
  expect(ctx.db.getSessionById(ctx.hySession.id)).not.toBeNull();
  await expect(ctx.resetAgent('main')).rejects.toThrow('main');
});

test('refuses shared workspaces and symlinked roots without deleting history', async () => {
  const ctx = await setup();
  const { upsertRegisteredAgent } = await import('../src/agents/agent-registry.ts');
  upsertRegisteredAgent({ id: 'other', workspace: 'hy' });
  await expect(ctx.resetAgent('hy')).rejects.toThrow('own workspace');
  const { deleteRegisteredAgent } = await import('../src/agents/agent-registry.ts');
  deleteRegisteredAgent('other');
  const root = path.dirname(ctx.hy);
  const moved = `${root}-original`;
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root);
  await expect(ctx.resetAgent('hy')).rejects.toThrow('managed directory');
  expect(ctx.db.getSessionById(ctx.hySession.id)).not.toBeNull();
  expect(fs.existsSync(path.join(moved, 'workspace', 'private.txt'))).toBe(true);
});

test.each([{}, { confirmation: 'yes' }, { confirmation: 'RESET AGENT', deleteHistory: 'no' }])('route requires a valid confirmation before deleting files: %j', async (body) => {
  const ctx = await setup();
  const { handleAgentResetRoute } = await import('../src/gateway/agent-reset-route.ts');
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: {} });
  const res = { status: 0, writeHead(status: number) { this.status = status; }, end() {} };
  expect(await handleAgentResetRoute(req as never, res as never, '/api/admin/agents/hy/reset')).toBe(true);
  expect(res.status).toBe(400);
  expect(fs.existsSync(path.join(ctx.hy, 'private.txt'))).toBe(true);
});

test('CLI requires confirmation and never falls back to local erasure if the gateway is unavailable', async () => {
  const ctx = await setup();
  await expect(ctx.handleAgentPackageCommand(['reset', 'hy'])).rejects.toThrow('interactive');
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  await expect(ctx.handleAgentPackageCommand(['reset', 'hy', '--yes'])).rejects.toThrow('offline');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ confirmation: 'RESET AGENT', deleteHistory: true });
  expect(fs.existsSync(path.join(ctx.hy, 'private.txt'))).toBe(true);
});

test('reset routes require delete permission rather than write permission', async () => {
  const { resolveAdminRbacAction, isAdminActionAllowed } = await import('../src/security/admin-rbac.ts');
  const action = resolveAdminRbacAction('/api/admin/agents/hy/reset', 'POST');
  expect(action).toBe('admin.agents.delete');
  expect(isAdminActionAllowed({ actions: ['admin.agents.write'] }, action!)).toBe(false);
});

test('busy agents fail before deleting files or history', async () => {
  const ctx = await setup();
  const executor = await import('../src/agent/executor.ts');
  vi.spyOn(executor, 'getInFlightExecutorSessionIds').mockReturnValue([ctx.hySession.id]);
  await expect(ctx.resetAgent('hy')).rejects.toThrow('busy');
  expect(fs.existsSync(path.join(ctx.hy, 'private.txt'))).toBe(true);
  expect(ctx.db.getSessionById(ctx.hySession.id)).toBeDefined();
});
