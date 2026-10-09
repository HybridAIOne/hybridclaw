import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleDataControlsRoute } from '../src/gateway/data-controls.js';
import {
  DEVICE_TOKEN_ACTIONS,
  OWNER_DEVICE_TOKEN_ACTIONS,
} from '../src/gateway/device-grants.js';
import { closeDatabase, initDatabase, withMemoryDatabase } from '../src/memory/database.js';
import { storeSemanticMemory, updateSessionSummary } from '../src/memory/semantic-memory.js';
import { getOrCreateSession } from '../src/memory/sessions.js';
import { resolveAdminRbacAction } from '../src/security/admin-rbac.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const homes = vi.hoisted(() => new Map<string, string>());
const running = vi.hoisted(() => ({ sessions: [] as string[] }));
vi.mock('../src/agents/agent-registry.js', () => ({
  listAgents: () => [...homes.keys()].map((id) => ({ id })),
  resolveAgentWorkspaceId: (id: string) => id,
}));
vi.mock('../src/infra/ipc.js', () => ({ agentWorkspaceDir: (id: string) => homes.get(id) }));
vi.mock('../src/agent/executor.js', () => ({
  getInFlightExecutorSessionIds: () => running.sessions,
}));
vi.mock('../src/memory/cloud-memory.js', () => ({
  loadCloudMemoryContextFiles: () => [
    { scope: 'company', name: 'Team.md', content: 'Fridays are remote.' },
  ],
  scheduleCloudMemorySync: () => {},
}));

const temp = useTempDir('data-controls-');
useCleanMocks({ cleanup: closeDatabase });
beforeEach(() => {
  homes.clear();
  running.sessions = [];
  initDatabase({ quiet: true, dbPath: path.join(temp(), 'memory.db') });
  const workspace = temp();
  fs.mkdirSync(path.join(workspace, 'memory'));
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '- Prefers tea\n');
  fs.writeFileSync(path.join(workspace, 'memory', '2026-10-08.md'), '- Dentist on Friday\n');
  homes.set('hy', workspace);
});

async function call(pathname: string, body?: unknown) {
  let status = 0;
  let payload = '';
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      payload = value;
    },
  } as unknown as ServerResponse;
  await handleDataControlsRoute(req, res, body === undefined ? 'GET' : 'POST', pathname);
  return { status, json: JSON.parse(payload) };
}
const memories = async () => (await call('/api/data-controls')).json.memories as Array<{
  id: string;
  kind: string;
  content: string;
  revision: string;
}>;

describe('data controls', () => {
  test('lists notes, summaries and read-only shared memory, but not untouched templates', async () => {
    const session = getOrCreateSession('hy-chat', null, 'web', 'hy');
    updateSessionSummary(session.id, 'Planning a trip to Lisbon.');
    const list = await memories();
    expect(list.map((memory) => [memory.kind, memory.id])).toEqual([
      ['note', 'note:hy:MEMORY.md'],
      ['note', 'note:hy:memory/2026-10-08.md'],
      ['summary', `summary:${session.id}`],
      ['shared', 'shared:company:Team.md'],
    ]);
  });

  test('edits a note in place and refuses an edit based on an old version', async () => {
    const [note] = await memories();
    const saved = await call('/api/data-controls/memories/update', {
      id: note.id,
      revision: note.revision,
      content: '- Prefers green tea\n',
    });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(path.join(homes.get('hy')!, 'MEMORY.md'), 'utf8')).toBe(
      '- Prefers green tea\n',
    );
    const stale = await call('/api/data-controls/memories/update', {
      id: note.id,
      revision: note.revision,
      content: 'Lost update',
    });
    expect(stale.status).toBe(409);
    expect((await memories())[0].content).toBe('- Prefers green tea\n');
  });

  test('an edited summary is also recalled in its new words', async () => {
    const session = getOrCreateSession('hy-chat', null, 'web', 'hy');
    updateSessionSummary(session.id, 'Planning a trip to Lisbon.');
    storeSemanticMemory({
      sessionId: session.id,
      role: 'assistant',
      source: 'compaction',
      scope: 'session',
      content: 'Planning a trip to Lisbon.',
      embedding: [0.1, 0.2],
    });
    const summary = (await memories()).find((memory) => memory.kind === 'summary')!;
    await call('/api/data-controls/memories/update', {
      id: summary.id,
      revision: summary.revision,
      content: 'Planning a trip to Porto.',
    });
    const rows = withMemoryDatabase((db) =>
      db.prepare('SELECT content, embedding FROM semantic_memories').all(),
    );
    expect(rows).toEqual([{ content: 'Planning a trip to Porto.', embedding: null }]);
  });

  test('refuses changes while Hy works, to shared memory, and without text', async () => {
    const session = getOrCreateSession('hy-chat', null, 'web', 'hy');
    const [note] = await memories();
    running.sessions = [session.id];
    const busy = await call('/api/data-controls/memories/update', {
      id: note.id,
      revision: note.revision,
      content: 'New',
    });
    expect(busy.status).toBe(409);
    running.sessions = [];
    const shared = await call('/api/data-controls/memories/update', {
      id: 'shared:company:Team.md',
      revision: 'any',
      content: 'New',
    });
    expect(shared.status).toBe(403);
    const empty = await call('/api/data-controls/memories/update', {
      id: note.id,
      revision: note.revision,
      content: '  ',
    });
    expect(empty.status).toBe(400);
  });

  test('deletes one memory, then all of them, keeping shared memory', async () => {
    const [, daily] = await memories();
    await call('/api/data-controls/memories/delete', {
      id: daily.id,
      revision: daily.revision,
      confirmation: 'delete',
    });
    expect(fs.existsSync(path.join(homes.get('hy')!, 'memory', '2026-10-08.md'))).toBe(false);
    const { json } = await call('/api/data-controls');
    const cleared = await call('/api/data-controls/memories/delete-all', {
      revision: json.memoryRevision,
      confirmation: 'delete',
    });
    expect(cleared.json.memories.map((memory: { kind: string }) => memory.kind)).toEqual([
      'shared',
    ]);
  });

  test('only the owner phone may read and change memories', () => {
    expect(resolveAdminRbacAction('/api/data-controls', 'GET')).toBe('data_controls.read');
    expect(resolveAdminRbacAction('/api/data-controls/memories/update', 'POST')).toBe(
      'data_controls.write',
    );
    expect(OWNER_DEVICE_TOKEN_ACTIONS).toEqual(
      expect.arrayContaining(['data_controls.read', 'data_controls.write']),
    );
    expect(DEVICE_TOKEN_ACTIONS).not.toContain('data_controls.read');
  });
});
