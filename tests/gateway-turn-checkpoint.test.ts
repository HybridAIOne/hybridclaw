import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { TurnCheckpoint } from '@hybridclaw/shared/turn-checkpoint';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('gateway-checkpoint-');
useCleanMocks({ unstubAllEnvs: true });
afterEach(async () => {
  const { cleanupGatewayRuntime } = await import(
    './helpers/gateway-test-setup.js'
  );
  await cleanupGatewayRuntime();
  vi.resetModules();
});

async function setup() {
  const root = temp();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.resetModules();
  const db = await import('../src/memory/db.js');
  const dbPath = path.join(root, 'checkpoint.db');
  db.initDatabase({ dbPath, quiet: true });
  const { memoryService: memory } = await import(
    '../src/memory/memory-service.js'
  );
  const session = memory.getOrCreateSession('checkpoint-session', null, 'web');
  const checkpoint = await import('../src/gateway/turn-checkpoint.js');
  const opts = {
    sessionId: session.id,
    agentId: 'main',
    userId: 'user_a',
    username: null,
    userContent: 'Save the sample report.',
    workspacePath: root,
    workerSessionId: session.id,
    runId: 'run-a',
    executorModeOverride: 'container' as const,
  };
  return { root, db, dbPath, memory, checkpoint, opts };
}

test('conversation exists before dispatch and recovers completed tools after reopening SQLite', async () => {
  const { root, db, dbPath, memory, checkpoint, opts } = await setup();
  checkpoint.beginTurnCheckpoint(opts);
  expect(
    memory
      .getConversationHistory(opts.sessionId, 10)
      .reverse()
      .map((entry) => entry.role),
  ).toEqual(['user', 'assistant']);
  const worker = new TurnCheckpoint(root, opts.sessionId, opts.runId);
  worker.assistant({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'write-a',
        type: 'function',
        function: {
          name: 'write',
          arguments: '{"path":"report.txt","content":"sample"}',
        },
      },
    ],
  });
  worker.start('write-a');
  worker.result({
    role: 'tool',
    tool_call_id: 'write-a',
    content: 'Report saved.',
  });
  db.closeDatabase();
  db.initDatabase({ dbPath, quiet: true });
  checkpoint.recoverTurnCheckpoint(opts.sessionId);
  checkpoint.recoverTurnCheckpoint(opts.sessionId);
  const rows = memory.getConversationHistory(opts.sessionId, 10).reverse();
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[1].tool_history_json!)[1].content).toBe(
    'Report saved.',
  );
  expect(fs.existsSync(path.join(root, 'report.txt'))).toBe(false);
});

test('finalization replaces provisional rows once and rolls back if storage fails', async () => {
  const { memory, checkpoint, opts } = await setup();
  checkpoint.beginTurnCheckpoint(opts);
  expect(() =>
    checkpoint.finishTurnCheckpoint(opts.sessionId, opts.runId, () => {
      throw new Error('Store failed.');
    }),
  ).toThrow();
  expect(
    memory.getConversationHistory(opts.sessionId, 10).reverse(),
  ).toHaveLength(2);
  checkpoint.finishTurnCheckpoint(opts.sessionId, opts.runId, () => {
    const userMessageId = memory.storeMessage({
      sessionId: opts.sessionId,
      userId: opts.userId,
      username: null,
      role: 'user',
      content: opts.userContent,
    });
    const assistantMessageId = memory.storeMessage({
      sessionId: opts.sessionId,
      userId: 'assistant',
      username: null,
      role: 'assistant',
      content: 'Done.',
    });
    return { userMessageId, assistantMessageId };
  });
  const rows = memory.getConversationHistory(opts.sessionId, 10).reverse();
  expect(rows).toHaveLength(2);
  expect(rows[1].content).toBe('Done.');
  checkpoint.recoverTurnCheckpoint(opts.sessionId);
  expect(memory.getConversationHistory(opts.sessionId, 10).reverse()).toEqual(
    rows,
  );
});

test.each(['missing', 'run_mismatch', 'unreadable'] as const)('%s worker journal preserves the user message and explicit uncertainty', async reason => {
  const { root, memory, checkpoint, opts } = await setup();
  checkpoint.beginTurnCheckpoint(opts);
  if (reason !== 'missing') new TurnCheckpoint(root, opts.sessionId, reason === 'run_mismatch' ? 'other-run' : opts.runId);
  const { turnCheckpointPath } = await import(
    '@hybridclaw/shared/turn-checkpoint'
  );
  if (reason === 'unreadable') fs.writeFileSync(turnCheckpointPath(root, opts.sessionId), '{');
  checkpoint.recoverTurnCheckpoint(opts.sessionId);
  const rows = memory.getConversationHistory(opts.sessionId, 10).reverse();
  expect(rows[0].content).toBe(opts.userContent);
  expect(rows[1].content).toContain(reason);
  expect(rows[1].tool_history_json).toBeNull();
});

test.each([undefined, 's_0123456789ab'])(
  'host recovery reads owner state outside the execution workspace (scope: %s)',
  async (scopeId) => {
    const { root, memory, checkpoint, opts } = await setup();
    const hostOpts = {
      ...opts,
      executorModeOverride: 'host' as const,
      runtimeScope: scopeId ? { agentId: opts.agentId, scopeId } : undefined,
    };
    const { hostWorkspaceStateRoot } = await import(
      '../src/infra/host-workspace.js'
    );
    const state = hostWorkspaceStateRoot(hostOpts);
    expect(state).not.toBe(root);
    checkpoint.beginTurnCheckpoint(hostOpts);
    const journal = new TurnCheckpoint(state, opts.workerSessionId, opts.runId);
    journal.assistant({ role: 'assistant', content: 'Saved in owner state.' });
    checkpoint.recoverTurnCheckpoint(opts.sessionId);
    const rows = memory.getConversationHistory(opts.sessionId, 10);
    expect(rows.find((entry) => entry.role === 'assistant')?.content).toContain(
      'Saved in owner state.',
    );
    expect(fs.existsSync(path.join(root, '.hybridclaw-runtime'))).toBe(false);
  },
);

test('run receipts survive reopening SQLite and prevent duplicate rows and file appends', async () => {
  const { db, dbPath, memory, checkpoint, opts } = await setup();
  const transcripts = await import('../src/session/session-transcripts.js');
  const transcript = vi.spyOn(transcripts, 'appendSessionTranscript').mockImplementation(() => {});
  const canonical = vi.spyOn(memory, 'appendCanonicalMessages').mockImplementation(() => {});
  const { storeTurnMessages } = await import('../src/gateway/turn-storage.js');
  checkpoint.beginTurnCheckpoint(opts);
  const completed = { ...opts, channelId: 'web', canonicalScopeId: 'scope-a', assistantContent: 'Done.' };
  const first = storeTurnMessages(completed);
  expect(transcript).toHaveBeenCalledTimes(2);
  expect(canonical).toHaveBeenCalledTimes(1);
  db.closeDatabase();
  db.initDatabase({ dbPath, quiet: true });
  expect(storeTurnMessages(completed)).toEqual(first);
  expect(memory.getConversationHistory(opts.sessionId, 10)).toHaveLength(2);
  expect(transcript).toHaveBeenCalledTimes(2);
  expect(canonical).toHaveBeenCalledTimes(1);
  expect(() => checkpoint.beginTurnCheckpoint(opts)).toThrow(/finalized/);
});

test('a wrong run cannot finalize a pending turn, and a late old run cannot replace the next one', async () => {
  const { memory, checkpoint, opts } = await setup();
  checkpoint.beginTurnCheckpoint(opts);
  const store = vi.fn(() => ({ userMessageId: 1, assistantMessageId: 2 }));
  expect(() => checkpoint.finishTurnCheckpoint(opts.sessionId, 'wrong-run', store)).toThrow(/match/);
  expect(store).not.toHaveBeenCalled();
  checkpoint.recoverTurnCheckpoint(opts.sessionId);
  const rows = memory.getConversationHistory(opts.sessionId, 10);
  checkpoint.beginTurnCheckpoint({ ...opts, runId: 'run-b' });
  const result = checkpoint.finishTurnCheckpoint(opts.sessionId, opts.runId, store);
  expect(result.stored).toBe(false);
  expect(store).not.toHaveBeenCalled();
  expect(memory.getConversationHistory(opts.sessionId, 10)).toHaveLength(rows.length + 2);
});

test('a failed receipt commit rolls back partial final storage and preserves the pending marker', async () => {
  const { memory, checkpoint, opts } = await setup();
  const { withMemoryDatabase } = await import('../src/memory/database.js');
  const { getMemoryValue } = await import('../src/memory/kv.js');
  const { storeTurnMessages } = await import('../src/gateway/turn-storage.js');
  checkpoint.beginTurnCheckpoint(opts);
  const before = memory.getConversationHistory(opts.sessionId, 10);
  withMemoryDatabase(database => database.exec(`
    CREATE TRIGGER fail_receipt BEFORE INSERT ON kv_store
    WHEN NEW.key LIKE 'gateway.turn-finalized.%'
    BEGIN SELECT RAISE(ABORT, 'Receipt storage failed'); END;
  `));
  const completed = { ...opts, channelId: 'web', canonicalScopeId: '', assistantContent: 'Done.' };
  expect(() => storeTurnMessages(completed)).toThrow(/Receipt storage failed/);
  expect(memory.getConversationHistory(opts.sessionId, 10)).toEqual(before);
  expect(getMemoryValue(opts.sessionId, 'gateway.turn-checkpoint')).toMatchObject({ runId: opts.runId });
  withMemoryDatabase(database => database.exec('DROP TRIGGER fail_receipt'));
  const first = storeTurnMessages(completed);
  expect(storeTurnMessages(completed)).toEqual(first);
  expect(memory.getConversationHistory(opts.sessionId, 10)).toHaveLength(2);
});
