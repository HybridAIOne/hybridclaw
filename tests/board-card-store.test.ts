import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { seedBoardCard } from './helpers/board-card-fixtures.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-board-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['node:crypto'],
});

let tmpDir: string;

async function loadBoardStore() {
  const dbModule = await import('../src/memory/db.js');
  const boardModule = await import('../src/board/card-store.js');
  dbModule.initDatabase({
    quiet: true,
    dbPath: path.join(tmpDir, 'data', 'hybridclaw.db'),
  });
  return { dbModule, boardModule };
}

beforeEach(() => {
  tmpDir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', tmpDir);
  vi.stubEnv('HOME', tmpDir);
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

  test('enforces canonical edge storage constraints for direct SQLite writes', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'logical-a',
      title: 'Logical A',
      owner: { agentId: 'agent_builder' },
    });
    seedBoardCard(dbModule, {
      id: 'logical-b',
      title: 'Logical B',
      owner: { agentId: 'agent_builder' },
    });

    expect(() =>
      dbModule.withMemoryDatabase((database) => {
        const insert = database.prepare(
          `INSERT INTO board_card_edges (
            id, from_card_id, to_card_id, kind, created_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const now = '2026-05-22T10:00:00.000Z';
        const actor = JSON.stringify({ system: 'test' });
        insert.run(
          'edge-blocks',
          'logical-a',
          'logical-b',
          'blocks',
          now,
          actor,
        );
        insert.run(
          'edge-blocked-by',
          'logical-b',
          'logical-a',
          'blocked_by',
          now,
          actor,
        );
      }),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      dbModule.withMemoryDatabase((database) => {
        const insert = database.prepare(
          `INSERT INTO board_card_edges (
            id, from_card_id, to_card_id, kind, created_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const now = '2026-05-22T10:00:00.000Z';
        const actor = JSON.stringify({ system: 'test' });
        insert.run(
          'edge-related-a',
          'logical-a',
          'logical-b',
          'related',
          now,
          actor,
        );
        insert.run(
          'edge-related-b',
          'logical-b',
          'logical-a',
          'related',
          now,
          actor,
        );
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  test('reads persisted cards with owner, column, source, deletion, and pagination filters', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    const createdAt = '2026-05-22T10:00:00.000Z';
    seedBoardCard(dbModule, {
      id: 'card-a',
      title: 'Triage work',
      body: 'Investigate an import failure.',
      owner: { agentId: 'agent_builder' },
      column: 'triage',
      source: 'autopilot/nightly',
      createdAt,
    });
    seedBoardCard(dbModule, {
      id: 'card-b',
      title: 'Manual work',
      owner: { userId: 'user_a' },
      createdAt,
    });
    seedBoardCard(dbModule, {
      id: 'card-c',
      title: 'Deleted work',
      owner: { agentId: 'agent_builder' },
      deletedAt: createdAt,
      createdAt,
    });

    expect(boardModule.listCards().map((card) => card.id)).toEqual([
      'card-a',
      'card-b',
    ]);
    expect(
      boardModule.listCards({
        column: 'triage',
        owner: { agentId: 'agent_builder' },
      }),
    ).toMatchObject([
      {
        id: 'card-a',
        body: 'Investigate an import failure.',
        source: 'autopilot/nightly',
        deletedAt: null,
        createdAt,
      },
    ]);
    expect(
      boardModule
        .listCards({ owner: { userId: 'user_a' }, source: 'manual' })
        .map((card) => card.id),
    ).toEqual(['card-b']);
    expect(
      boardModule
        .listCards({ sourcePrefix: 'autopilot' })
        .map((card) => card.id),
    ).toEqual(['card-a']);
    expect(boardModule.listCards({ sourcePrefix: 'workflow' })).toEqual([]);
    expect(boardModule.listCards({ includeDeleted: true })).toHaveLength(3);
    expect(
      boardModule.listCards({ limit: 1, offset: 1 }).map((card) => card.id),
    ).toEqual(['card-b']);
    expect(boardModule.listCards({ limit: 0 })).toEqual([]);
    expect(() =>
      boardModule.listCards({ source: 'autopilot/../../secret' }),
    ).toThrow(/Unsupported board card source/);
    expect(() => boardModule.listCards({ limit: -1 })).toThrow(
      /non-negative integer/,
    );
  });

  test('rejects edges to missing or deleted cards and self references', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'active',
      title: 'Active work',
      owner: { agentId: 'agent_builder' },
    });
    seedBoardCard(dbModule, {
      id: 'deleted',
      title: 'Deleted work',
      owner: { userId: 'user_a' },
      deletedAt: '2026-05-22T10:00:00.000Z',
    });
    expect(() => boardModule.addEdge('missing', 'active', 'blocks')).toThrow(
      'Board card not found: missing',
    );
    expect(() => boardModule.addEdge('active', 'deleted', 'related')).toThrow(
      'Board card not found: deleted',
    );
    expect(() => boardModule.addEdge('active', 'active', 'related')).toThrow(
      /same card/,
    );
    expect(boardModule.listEdges('active')).toEqual([]);
  });

  test('round-trips blocks and blocked_by as one stored logical edge', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'blocker',
      title: 'Blocking work',
      owner: { agentId: 'agent_builder' },
    });
    seedBoardCard(dbModule, {
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
      createdBy: { type: 'user', id: 'user_a' },
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
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'card-a',
      title: 'Card A',
      owner: { agentId: 'agent_builder' },
    });
    seedBoardCard(dbModule, {
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
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'dependency',
      title: 'Dependency',
      owner: { agentId: 'agent_builder' },
      column: 'in_progress',
    });
    seedBoardCard(dbModule, {
      id: 'dependent',
      title: 'Dependent',
      owner: { agentId: 'agent_builder' },
      column: 'todo',
    });
    boardModule.addEdge('dependent', 'dependency', 'blocked_by');

    expect(boardModule.isBlocked('dependent')).toBe(true);

    dbModule.withMemoryDatabase((database) =>
      database
        .prepare("UPDATE board_cards SET status = 'complete' WHERE id = ?")
        .run('dependency'),
    );
    expect(boardModule.isBlocked('dependent')).toBe(true);

    dbModule.withMemoryDatabase((database) =>
      database
        .prepare('UPDATE board_cards SET "column" = \'done\' WHERE id = ?')
        .run('dependency'),
    );
    expect(boardModule.isBlocked('dependent')).toBe(false);
  });

  test('rejects inverse-direction insertion with a clear error', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'card-one',
      title: 'Card One',
      owner: { agentId: 'agent_builder' },
    });
    seedBoardCard(dbModule, {
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
    vi.doMock('node:crypto', async () => {
      const actual =
        await vi.importActual<typeof import('node:crypto')>('node:crypto');
      return {
        ...actual,
        randomUUID: vi.fn(() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      };
    });

    const { boardModule, dbModule } = await loadBoardStore();
    const { subscribeRuntimeEvents, subscribeSkillRunEvents } = await import(
      '../src/skills/skill-run-events.js'
    );
    const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
    const runtimeEvents: unknown[] = [];
    const skillRunEvents: unknown[] = [];
    const unsubscribeRuntime = subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
    const unsubscribeSkillRun = subscribeSkillRunEvents((event) => {
      skillRunEvents.push(event);
    });

    seedBoardCard(dbModule, {
      id: 'event-blocker',
      title: 'Event blocker',
      owner: { userId: 'user_a' },
    });
    seedBoardCard(dbModule, {
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
    expect(edge.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    boardModule.removeEdge(edge.id, {
      actor: { userId: 'user_a' },
      sessionId: 'board-edge-event-session',
      runId: 'board-edge-event-run',
    });
    unsubscribeRuntime();
    unsubscribeSkillRun();

    expect(runtimeEvents).toMatchObject([
      {
        type: 'board.edge_added',
        actor: { type: 'user', id: 'user_a' },
        edgeId: edge.id,
        fromCardId: 'event-blocker',
        toCardId: 'event-blocked',
        kind: 'blocks',
      },
      {
        type: 'board.edge_removed',
        actor: { type: 'user', id: 'user_a' },
        edgeId: edge.id,
        fromCardId: 'event-blocker',
        toCardId: 'event-blocked',
        kind: 'blocks',
      },
    ]);
    expect(skillRunEvents).toHaveLength(0);

    await flushAuditTrail();
    const audit = dbModule.getRecentStructuredAuditForSession(
      'board-edge-event-session',
      10,
    );
    expect(audit.map((entry) => entry.event_type)).toEqual([
      'board.edge_removed',
      'board.edge_added',
    ]);
    expect(JSON.parse(audit[0]?.payload || '{}')).toMatchObject({
      actor: { type: 'user', id: 'user_a' },
      edgeId: edge.id,
      fromCardId: 'event-blocker',
      toCardId: 'event-blocked',
      kind: 'blocks',
    });
  });

  test('restores removed edges through F4 revisions', async () => {
    const { boardModule, dbModule } = await loadBoardStore();
    seedBoardCard(dbModule, {
      id: 'restore-blocker',
      title: 'Restore blocker',
      owner: { userId: 'user_a' },
    });
    seedBoardCard(dbModule, {
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
