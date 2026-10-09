import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'data-controls-chats-',
});

async function setup() {
  setupHome();
  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', displayName: 'Hy', markdown: { 'IDENTITY.md': '# Hy' } }),
    '--activate',
  ]);
  const db = await import('../src/memory/db.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { handleDataControlsRoute } = await import(
    '../src/gateway/data-controls.ts'
  );
  const say = (sessionId: string, role: string, content: string) =>
    db.storeMessage(sessionId, 'phone', null, role, content, 'hy');
  const call = async (pathname: string, body?: unknown) => {
    let status = 0;
    let payload: Buffer | string = '';
    let headers: Record<string, unknown> = {};
    const req = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    const res = {
      setHeader() {},
      writeHead(code: number, values?: Record<string, unknown>) {
        status = code;
        headers = values ?? {};
      },
      end(value: Buffer | string) {
        payload = value;
      },
    } as unknown as ServerResponse;
    await handleDataControlsRoute(
      req,
      res,
      body === undefined ? 'GET' : 'POST',
      pathname,
    );
    return { status, headers, payload };
  };
  const snapshot = async () =>
    JSON.parse(String((await call('/api/data-controls')).payload));
  return { db, workspace: agentWorkspaceDir('hy'), say, call, snapshot };
}

test('lists phone chats across their session rows, and archives side chats only', async () => {
  const ctx = await setup();
  const main = ctx.db.getOrCreateSession('main-abc', null, 'web', 'hy');
  ctx.say(main.id, 'user', 'Good morning');
  const side = ctx.db.getOrCreateSession('ios-trip', null, 'web', 'hy');
  ctx.say(side.id, 'user', 'Plan a weekend in Lisbon with trains only please');
  const fresh = ctx.db.createFreshSessionInstance(side.id).session;
  ctx.say(fresh.id, 'user', 'And a hotel near the river');
  const cron = ctx.db.getOrCreateSession('cron:daily', null, 'scheduler', 'hy');
  ctx.say(cron.id, 'user', 'Scheduled check');

  const { chats } = await ctx.snapshot();
  expect(chats.map((chat: { id: string }) => chat.id).sort()).toEqual([
    'ios-trip',
    'main-abc',
  ]);
  const trip = chats.find((chat: { id: string }) => chat.id === 'ios-trip');
  expect(trip).toMatchObject({ messageCount: 2, archived: false, agent: 'hy' });
  expect(trip.title).toBe('Plan a weekend in Lisbon with trains only please');

  const archived = await ctx.call('/api/data-controls/chats/archive', {
    id: 'ios-trip',
    revision: trip.revision,
    archived: true,
  });
  expect(archived.status).toBe(200);
  expect(
    JSON.parse(String(archived.payload)).chats.find(
      (chat: { id: string }) => chat.id === 'ios-trip',
    ).archived,
  ).toBe(true);
  const stale = await ctx.call('/api/data-controls/chats/archive', {
    id: 'ios-trip',
    revision: trip.revision,
    archived: false,
  });
  expect(stale.status).toBe(409);
  const mainChat = chats.find((chat: { id: string }) => chat.id === 'main-abc');
  const mainArchive = await ctx.call('/api/data-controls/chats/archive', {
    id: 'main-abc',
    revision: mainChat.revision,
    archived: true,
  });
  expect(mainArchive.status).toBe(400);
});

test('deleting a chat removes every session row and what refers to it', async () => {
  const ctx = await setup();
  const side = ctx.db.getOrCreateSession('android-notes', null, 'web', 'hy');
  ctx.say(side.id, 'user', 'Remember the code word');
  const fresh = ctx.db.createFreshSessionInstance(side.id).session;
  const last = ctx.say(fresh.id, 'assistant', 'Noted.');
  const keep = ctx.db.getOrCreateSession('ios-other', null, 'web', 'hy');
  ctx.say(keep.id, 'user', 'Keep me');
  ctx.db.appendCanonicalMessages({
    agentId: 'hy',
    userId: 'android-notes',
    newMessages: [{ role: 'user', content: 'Remember the code word', sessionId: side.id }],
  });
  const transcripts = path.join(ctx.workspace, '.session-transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, `${side.id}.jsonl`), '{}\n');

  const chat = (await ctx.snapshot()).chats.find(
    (candidate: { id: string }) => candidate.id === 'android-notes',
  );
  const refused = await ctx.call('/api/data-controls/chats/delete', {
    id: chat.id,
    revision: chat.revision,
  });
  expect(refused.status).toBe(400);
  const deleted = await ctx.call('/api/data-controls/chats/delete', {
    id: chat.id,
    revision: chat.revision,
    confirmation: 'delete',
    deleteMemories: true,
  });
  expect(deleted.status).toBe(200);
  const result = JSON.parse(String(deleted.payload));
  expect(result.chats.map((candidate: { id: string }) => candidate.id)).toEqual([
    'ios-other',
  ]);
  expect(result.deletedChats).toEqual(['android-notes']);
  expect(result.deletions[0]).toMatchObject({ id: 'android-notes', lastMessageID: last });
  expect(ctx.db.getSessionById(side.id)).toBeUndefined();
  expect(ctx.db.getSessionById(fresh.id)).toBeUndefined();
  expect(fs.existsSync(path.join(transcripts, `${side.id}.jsonl`))).toBe(false);
  expect(
    ctx.db.withMemoryDatabase((db) =>
      db.prepare('SELECT COUNT(*) AS n FROM canonical_sessions').get(),
    ),
  ).toEqual({ n: 0 });
});

test('the export holds chats, memories and workspace documents, not hidden files', async () => {
  const ctx = await setup();
  const side = ctx.db.getOrCreateSession('ios-trip', null, 'web', 'hy');
  ctx.say(side.id, 'user', 'Plan a weekend in Lisbon');
  fs.writeFileSync(path.join(ctx.workspace, 'MEMORY.md'), '- Prefers trains\n');
  fs.writeFileSync(path.join(ctx.workspace, 'packing-list.md'), '- Passport\n');
  fs.writeFileSync(path.join(ctx.workspace, '.env'), 'SECRET=1\n');

  const exported = await ctx.call('/api/data-controls/export');
  expect(exported.status).toBe(200);
  expect(exported.headers['Content-Type']).toBe('application/zip');
  const { default: yauzl } = await import('yauzl');
  const names = await new Promise<string[]>((resolve, reject) => {
    yauzl.fromBuffer(exported.payload as Buffer, (error, zip) => {
      if (error || !zip) return reject(error);
      const found: string[] = [];
      zip.on('entry', (entry) => found.push(entry.fileName));
      zip.on('end', () => resolve(found));
    });
  });
  expect(names).toEqual(
    expect.arrayContaining([
      'README.txt',
      'memories.json',
      'chats/ios-trip.json',
      'chats/ios-trip.md',
      'files/hy/packing-list.md',
      'files/hy/MEMORY.md',
    ]),
  );
  expect(names.some((name) => name.includes('.env'))).toBe(false);
});

test("deleting a scoped chat removes its transcript from the scope", async () => {
  const ctx = await setup();
  const { createScope } = await import('../src/scopes/scope-store.ts');
  const { bindRequestedScope } = await import('../src/scopes/scope-session.ts');
  const work = createScope({ agentId: 'hy', name: 'Work', connectors: [] });
  bindRequestedScope({
    sessionId: 'ios-work',
    guildId: null,
    channelId: 'web',
    agentId: 'hy',
    requestedScope: work.id,
  });
  ctx.say('ios-work', 'user', 'About the invoice');
  const transcript = path.join(
    ctx.workspace,
    'scopes',
    work.id,
    '.session-transcripts',
    'ios-work.jsonl',
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{}\n');
  const chat = (await ctx.snapshot()).chats.find(
    (candidate: { id: string }) => candidate.id === 'ios-work',
  );

  const deleted = await ctx.call('/api/data-controls/chats/delete', {
    id: chat.id,
    revision: chat.revision,
    confirmation: 'delete',
  });

  expect(deleted.status).toBe(200);
  expect(fs.existsSync(transcript)).toBe(false);
});
