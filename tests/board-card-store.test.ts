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
  test('migrates the board card and edge tables', async () => {
    const { dbModule } = await loadBoardStore();
    const inspect = new Database(path.join(tmpDir, 'data', 'hybridclaw.db'), {
      readonly: true,
    });
    const columns = inspect
      .prepare(`PRAGMA table_info(board_cards)`)
      .all() as Array<{ name: string }>;
    const edgeColumns = inspect
      .prepare(`PRAGMA table_info(board_card_edges)`)
      .all() as Array<{ name: string }>;
    const schemaVersion = inspect.pragma('user_version', { simple: true });
    inspect.close();

    expect(Number(schemaVersion)).toBe(dbModule.DATABASE_SCHEMA_VERSION);
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
    expect(edgeColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'from_card_id',
        'to_card_id',
        'kind',
        'created_at',
        'created_by',
      ]),
    );
  });

  test('enforces edge card foreign keys for direct SQLite writes', async () => {
    const { dbModule } = await loadBoardStore();

    expect(() =>
      dbModule.withMemoryDatabase((database) => {
        database
          .prepare(
            `INSERT INTO board_card_edges (
              id, from_card_id, to_card_id, kind, created_at, created_by
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'edge-missing-card',
            'missing-from',
            'missing-to',
            'related',
            '2026-05-22T10:00:00.000Z',
            JSON.stringify({ system: 'test' }),
          );
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
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
    expect(boardModule.listCards({ source: 'manual' })).toHaveLength(1);
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
      parent: '',
    });
    expect(cleared.parent).toBeNull();
    expect(cleared.createdAt).toBe(created.createdAt);
  });

  test('rejects unsafe source identifiers', async () => {
    const { boardModule } = await loadBoardStore();

    expect(() =>
      boardModule.createCard({
        id: 'card-unsafe-source',
        title: 'Unsafe source',
        owner: { agentId: 'agent_builder' },
        source: 'autopilot/../../secret' as `autopilot/${string}`,
      }),
    ).toThrow(/Unsupported board card source/);
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

  test('emits board mutations through F2 runtime events and structured audit', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    const { subscribeRuntimeEvents, subscribeSkillRunEvents } = await import(
      '../src/skills/skill-run-events.js'
    );
    const runtimeEvents: unknown[] = [];
    const boardEvents: unknown[] = [];
    const skillRunEvents: unknown[] = [];
    const unsubscribeRuntime = subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
    const unsubscribeBoard = boardModule.subscribeBoardCardEvents((event) => {
      boardEvents.push(event);
    });
    const unsubscribeSkillRun = subscribeSkillRunEvents((event) => {
      skillRunEvents.push(event);
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
    unsubscribeRuntime();
    unsubscribeBoard();
    unsubscribeSkillRun();

    expect(runtimeEvents).toHaveLength(1);
    expect(runtimeEvents[0]).toMatchObject({
      type: 'board.card_created',
      actor: { userId: 'user_a' },
      cardId: 'card-event',
      diff: {
        id: { before: null, after: 'card-event' },
        source: { before: null, after: 'a2a/envelope-1' },
      },
    });
    expect(boardEvents).toEqual(runtimeEvents);
    expect(skillRunEvents).toHaveLength(0);

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

  test('round-trips blocks and blocked_by as one stored logical edge', async () => {
    const { boardModule } = await loadBoardStore();
    boardModule.createCard({
      id: 'blocker',
      title: 'Blocking work',
      owner: { agentId: 'agent_builder' },
    });
    boardModule.createCard({
      id: 'blocked',
      title: 'Blocked work',
      owner: { agentId: 'agent_builder' },
    });

    const edge = boardModule.addEdge('blocker', 'blocked', 'blocks', {
      actor: { userId: 'user_a' },
    });

    expect(edge).toMatchObject({
      fromCardId: 'blocker',
      toCardId: 'blocked',
      kind: 'blocks',
      createdBy: { userId: 'user_a' },
    });
    expect(boardModule.listEdges('blocker')).toMatchObject([
      {
        id: edge.id,
        fromCardId: 'blocker',
        toCardId: 'blocked',
        kind: 'blocks',
      },
    ]);
    expect(boardModule.listEdges('blocked')).toMatchObject([
      {
        id: edge.id,
        fromCardId: 'blocked',
        toCardId: 'blocker',
        kind: 'blocked_by',
      },
    ]);
    expect(boardModule.listEdges('blocked', 'blocked_by')).toHaveLength(1);
    expect(boardModule.listEdges('blocked', 'blocks')).toHaveLength(0);
  });

  test('related edges are symmetric regardless of insertion direction', async () => {
    const { boardModule } = await loadBoardStore();
    boardModule.createCard({
      id: 'card-a',
      title: 'Card A',
      owner: { agentId: 'agent_builder' },
    });
    boardModule.createCard({
      id: 'card-b',
      title: 'Card B',
      owner: { agentId: 'agent_builder' },
    });

    const edge = boardModule.addEdge('card-b', 'card-a', 'related');

    expect(edge).toMatchObject({
      fromCardId: 'card-b',
      toCardId: 'card-a',
      kind: 'related',
    });
    expect(boardModule.listEdges('card-a', 'related')).toMatchObject([
      {
        id: edge.id,
        fromCardId: 'card-a',
        toCardId: 'card-b',
        kind: 'related',
      },
    ]);
    expect(boardModule.listEdges('card-b', 'related')).toMatchObject([
      {
        id: edge.id,
        fromCardId: 'card-b',
        toCardId: 'card-a',
        kind: 'related',
      },
    ]);
  });

  test('isBlocked returns false once every blocker moves to done', async () => {
    const { boardModule } = await loadBoardStore();
    boardModule.createCard({
      id: 'dependency',
      title: 'Dependency',
      owner: { agentId: 'agent_builder' },
      column: 'in_progress',
    });
    boardModule.createCard({
      id: 'dependent',
      title: 'Dependent',
      owner: { agentId: 'agent_builder' },
      column: 'todo',
    });
    boardModule.addEdge('dependent', 'dependency', 'blocked_by');

    expect(boardModule.isBlocked('dependent')).toBe(true);

    boardModule.updateCard('dependency', { status: 'complete' });
    expect(boardModule.isBlocked('dependent')).toBe(true);

    boardModule.updateCard('dependency', { column: 'done' });
    expect(boardModule.isBlocked('dependent')).toBe(false);
  });

  test('rejects inverse-direction insertion with a clear error', async () => {
    const { boardModule } = await loadBoardStore();
    boardModule.createCard({
      id: 'card-one',
      title: 'Card One',
      owner: { agentId: 'agent_builder' },
    });
    boardModule.createCard({
      id: 'card-two',
      title: 'Card Two',
      owner: { agentId: 'agent_builder' },
    });
    boardModule.addEdge('card-one', 'card-two', 'blocks');

    expect(() =>
      boardModule.addEdge('card-two', 'card-one', 'blocked_by'),
    ).toThrow('Board card edge already exists: card-two blocked_by card-one');
  });

  test('emits board edge mutations through F2 runtime events and structured audit', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    const { subscribeRuntimeEvents, subscribeSkillRunEvents } = await import(
      '../src/skills/skill-run-events.js'
    );
    const runtimeEvents: unknown[] = [];
    const edgeEvents: unknown[] = [];
    const skillRunEvents: unknown[] = [];
    const unsubscribeRuntime = subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
    const unsubscribeEdge = boardModule.subscribeBoardEdgeEvents((event) => {
      edgeEvents.push(event);
    });
    const unsubscribeSkillRun = subscribeSkillRunEvents((event) => {
      skillRunEvents.push(event);
    });

    boardModule.createCard({
      id: 'event-blocker',
      title: 'Event blocker',
      owner: { userId: 'user_a' },
    });
    boardModule.createCard({
      id: 'event-blocked',
      title: 'Event blocked',
      owner: { userId: 'user_a' },
    });
    runtimeEvents.length = 0;
    const edge = boardModule.addEdge(
      'event-blocker',
      'event-blocked',
      'blocks',
      {
        actor: { userId: 'user_a' },
        sessionId: 'board-edge-event-session',
        runId: 'board-edge-event-run',
      },
    );
    boardModule.removeEdge(edge.id, {
      actor: { userId: 'user_a' },
      sessionId: 'board-edge-event-session',
      runId: 'board-edge-event-run',
    });
    unsubscribeRuntime();
    unsubscribeEdge();
    unsubscribeSkillRun();

    expect(runtimeEvents).toMatchObject([
      {
        type: 'board.edge_added',
        actor: { userId: 'user_a' },
        edgeId: edge.id,
        fromCardId: 'event-blocker',
        toCardId: 'event-blocked',
        kind: 'blocks',
      },
      {
        type: 'board.edge_removed',
        actor: { userId: 'user_a' },
        edgeId: edge.id,
        fromCardId: 'event-blocker',
        toCardId: 'event-blocked',
        kind: 'blocks',
      },
    ]);
    expect(edgeEvents).toEqual(runtimeEvents);
    expect(skillRunEvents).toHaveLength(0);

    const audit = dbModule.getRecentStructuredAuditForSession(
      'board-edge-event-session',
      10,
    );
    expect(audit.map((entry) => entry.event_type)).toEqual([
      'board.edge_removed',
      'board.edge_added',
    ]);
    expect(JSON.parse(audit[0]?.payload || '{}')).toMatchObject({
      actor: { userId: 'user_a' },
      edgeId: edge.id,
      fromCardId: 'event-blocker',
      toCardId: 'event-blocked',
      kind: 'blocks',
    });
  });

  test('restores removed edges through F4 revisions', async () => {
    const { boardModule } = await loadBoardStore();
    boardModule.createCard({
      id: 'restore-blocker',
      title: 'Restore blocker',
      owner: { userId: 'user_a' },
    });
    boardModule.createCard({
      id: 'restore-blocked',
      title: 'Restore blocked',
      owner: { userId: 'user_a' },
    });
    const edge = boardModule.addEdge(
      'restore-blocked',
      'restore-blocker',
      'blocked_by',
    );
    boardModule.removeEdge(edge.id);
    expect(boardModule.listEdges('restore-blocked')).toHaveLength(0);

    const revision = boardModule.listEdgeRevisions(edge.id)[0];
    expect(revision).toBeTruthy();
    if (!revision) throw new Error('Expected edge revision.');

    const restored = boardModule.restoreEdgeRevision(edge.id, revision.id);
    expect(restored).toMatchObject({
      id: edge.id,
      fromCardId: 'restore-blocker',
      toCardId: 'restore-blocked',
      kind: 'blocks',
    });
    expect(boardModule.listEdges('restore-blocked')).toMatchObject([
      {
        id: edge.id,
        fromCardId: 'restore-blocked',
        toCardId: 'restore-blocker',
        kind: 'blocked_by',
      },
    ]);
  });
});
