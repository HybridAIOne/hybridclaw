import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmpDir: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;

async function loadBoardStore() {
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  vi.resetModules();
  const dbModule = await import('../src/memory/db.js');
  const boardModule = await import('../src/board/card-store.js');
  dbModule.initDatabase({
    quiet: true,
    dbPath: path.join(tmpDir, 'data', 'hybridclaw.db'),
  });
  return { dbModule, boardModule };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-board-'));
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.sequential('board card store', () => {
  test('migrates the board card table', async () => {
    const { dbModule } = await loadBoardStore();
    const inspect = new Database(path.join(tmpDir, 'data', 'hybridclaw.db'), {
      readonly: true,
    });
    const columns = inspect
      .prepare(`PRAGMA table_info(board_cards)`)
      .all() as Array<{ name: string }>;
    inspect.close();

    expect(dbModule.DATABASE_SCHEMA_VERSION).toBe(30);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'body',
        'owner',
        'column',
        'status',
        'source',
        'parent',
        'created_at',
        'updated_at',
        'deleted_at',
      ]),
    );
  });

  test('round-trips create, get, update, list, and soft-delete', async () => {
    const { boardModule } = await loadBoardStore();

    const created = boardModule.createCard(
      {
        id: 'card-1',
        title: 'Investigate importer failure',
        body: 'The nightly import failed on row 42.',
        owner: { agentId: 'agent_builder' },
        column: 'triage',
        status: 'queued',
        source: 'manual',
      },
      { actor: { userId: 'user_a' }, sessionId: 'board-test' },
    );

    expect(boardModule.getCard('card-1')).toMatchObject({
      id: 'card-1',
      owner: { agentId: 'agent_builder' },
      column: 'triage',
      deletedAt: null,
    });

    const updated = boardModule.updateCard(
      created.id,
      {
        title: 'Fix importer failure',
        status: 'running',
        parent: 'parent-card',
      },
      { actor: { agentId: 'agent_builder' }, sessionId: 'board-test' },
    );

    expect(updated).toMatchObject({
      title: 'Fix importer failure',
      column: 'triage',
      status: 'running',
      parent: 'parent-card',
    });
    expect(
      boardModule.listCards({
        column: 'triage',
        owner: { agentId: 'agent_builder' },
      }),
    ).toHaveLength(1);
    expect(boardModule.listCards({ sourcePrefix: 'manual' })).toHaveLength(1);
    expect(boardModule.listCards({ sourcePrefix: 'autopilot' })).toHaveLength(
      0,
    );

    const deleted = boardModule.deleteCard('card-1', {
      actor: { userId: 'user_a' },
      sessionId: 'board-test',
    });
    expect(deleted.deletedAt).toBeTruthy();
    expect(boardModule.getCard('card-1')).toBeNull();
    expect(boardModule.listCards({ includeDeleted: true })).toHaveLength(1);
  });

  test('update ignores undefined patch values and preserves createdAt', async () => {
    const { boardModule } = await loadBoardStore();

    const created = boardModule.createCard({
      id: 'card-undefined-patch',
      title: 'Patch target',
      body: 'Body',
      owner: { agentId: 'agent_builder' },
      status: 'queued',
      parent: 'parent-card',
      source: 'autopilot/nightly',
    });

    const updated = boardModule.updateCard('card-undefined-patch', {
      title: undefined,
      status: undefined,
      parent: undefined,
      body: 'Updated body',
    });

    expect(updated).toMatchObject({
      title: 'Patch target',
      body: 'Updated body',
      status: 'queued',
      parent: 'parent-card',
      source: 'autopilot/nightly',
      createdAt: created.createdAt,
    });
    expect(boardModule.listCards({ sourcePrefix: 'autopilot' })).toHaveLength(
      1,
    );

    const cleared = boardModule.updateCard('card-undefined-patch', {
      parent: null,
    });
    expect(cleared.parent).toBeNull();
    expect(cleared.createdAt).toBe(created.createdAt);
  });

  test('restores prior field state through F4 revisions', async () => {
    const { boardModule } = await loadBoardStore();

    boardModule.createCard({
      id: 'card-rollback',
      title: 'Original title',
      body: 'Original body',
      owner: { userId: 'user_a' },
      column: 'todo',
      status: 'queued',
      source: 'workflow/step-1',
    });
    boardModule.updateCard('card-rollback', {
      title: 'Changed title',
      body: 'Changed body',
      status: 'complete',
    });

    const revisions = boardModule.listCardRevisions('card-rollback');
    const originalRevision = revisions[0];
    expect(originalRevision).toBeTruthy();
    if (!originalRevision) throw new Error('Expected card revision.');

    const restored = boardModule.restoreCardRevision(
      'card-rollback',
      originalRevision.id,
      { actor: { userId: 'user_a' }, sessionId: 'board-test' },
    );

    expect(restored).toMatchObject({
      title: 'Original title',
      body: 'Original body',
      column: 'todo',
      status: 'queued',
      deletedAt: null,
    });

    boardModule.deleteCard('card-rollback', {
      actor: { userId: 'user_a' },
      sessionId: 'board-test',
    });
    expect(boardModule.getCard('card-rollback')).toBeNull();

    const preDeleteRevision = boardModule.listCardRevisions('card-rollback')[0];
    expect(preDeleteRevision).toBeTruthy();
    if (!preDeleteRevision) throw new Error('Expected pre-delete revision.');

    const undeleted = boardModule.restoreCardRevision(
      'card-rollback',
      preDeleteRevision.id,
      { actor: { userId: 'user_a' }, sessionId: 'board-test' },
    );
    expect(undeleted).toMatchObject({
      title: 'Original title',
      deletedAt: null,
    });
  });

  test('uses last-write-wins for sequential concurrent-style updates', async () => {
    const { boardModule } = await loadBoardStore();

    boardModule.createCard({
      id: 'card-concurrent',
      title: 'Start',
      owner: { agentId: 'agent_builder' },
    });

    boardModule.updateCard('card-concurrent', { status: 'running' });
    boardModule.updateCard('card-concurrent', { status: 'paused' });

    expect(boardModule.getCard('card-concurrent')).toMatchObject({
      status: 'paused',
    });
  });

  test('emits F2-shaped board events to subscribers and structured audit', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    const received: unknown[] = [];
    const unsubscribe = boardModule.subscribeBoardCardEvents((event) => {
      received.push(event);
    });

    boardModule.createCard(
      {
        id: 'card-event',
        title: 'Emit event',
        owner: { userId: 'user_a' },
        source: 'a2a/envelope-1',
      },
      {
        actor: { userId: 'user_a' },
        sessionId: 'board-event-session',
        runId: 'board-event-run',
      },
    );
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'board.card_created',
      actor: { userId: 'user_a' },
      cardId: 'card-event',
      diff: {
        id: { before: null, after: 'card-event' },
        source: { before: null, after: 'a2a/envelope-1' },
      },
    });

    const audit = dbModule.getRecentStructuredAuditForSession(
      'board-event-session',
      10,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event_type: 'board.card_created',
      run_id: 'board-event-run',
    });
    expect(JSON.parse(audit[0]?.payload || '{}')).toMatchObject({
      actor: { userId: 'user_a' },
      cardId: 'card-event',
      diff: expect.any(Object),
    });
  });
});
