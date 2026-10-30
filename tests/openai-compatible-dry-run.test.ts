import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-openai-dry-run-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

// Usage and audit are the records a dry run keeps.
const ACCOUNTING_TABLES = new Set(['usage_events', 'audit_events', 'audit_log']);
// Counters and full-text index segments, not stored data.
const isBookkeeping = (name: string, virtualTables: string[]) =>
  name === 'sqlite_sequence' ||
  virtualTables.some((table) => name.startsWith(`${table}_`));

function makeRequest(body: unknown, headers: Record<string, string>) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
  });
}

function makeResponse() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    body: '',
    headers,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, values: Record<string, string> = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(values)) {
        headers[key.toLowerCase()] = value;
      }
      return this;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
    },
  };
}

function snapshotFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(root, file)] = createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
  }
  return files;
}

test('a dry run answers from the real agent and leaves only usage and audit behind', async () => {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.js');
  const { withMemoryDatabase } = await import('../src/memory/database.js');
  const { ensureBootstrapFiles } = await import('../src/workspace.js');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
  const { flushTokenUsageBuffer } = await import(
    '../src/usage/token-usage-buffer.js'
  );
  const { getRecentStructuredAuditForSession } = await import(
    '../src/memory/audit.js'
  );
  const { handleOpenAICompatibleChatCompletions } = await import(
    '../src/gateway/openai-compatible.js'
  );
  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Order 42 ships on Friday.',
    toolsUsed: [],
    toolExecutions: [],
    tokenUsage: {
      modelCalls: 1,
      apiUsageAvailable: true,
      apiPromptTokens: 120,
      apiCompletionTokens: 8,
      apiTotalTokens: 128,
      estimatedPromptTokens: 120,
      estimatedCompletionTokens: 8,
      estimatedTotalTokens: 128,
    },
  });
  const ask = async (headers: Record<string, string>) => {
    const res = makeResponse();
    await handleOpenAICompatibleChatCompletions(
      makeRequest(
        {
          model: 'openai-codex/gpt-5-codex',
          messages: [
            { role: 'user', content: 'When does order 42 ship?' },
            { role: 'assistant', content: 'Let me check.' },
            { role: 'user', content: 'So when does order 42 ship?' },
          ],
        },
        headers,
      ) as never,
      res as never,
    );
    return res;
  };
  ensureBootstrapFiles('main');
  const workspace = agentWorkspaceDir('main');
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'Orders ship Fridays.\n');
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'memory', '2026-10-30.md'),
    '- user_a asked about order 42\n',
  );
  const snapshotTables = () =>
    withMemoryDatabase((db) => {
      const tables = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string; sql: string | null }>;
      const virtualTables = tables
        .filter(({ sql }) => sql?.startsWith('CREATE VIRTUAL TABLE'))
        .map(({ name }) => name);
      return Object.fromEntries(
        tables
          .filter(
            ({ name }) =>
              !ACCOUNTING_TABLES.has(name) &&
              !isBookkeeping(name, virtualTables),
          )
          .map(({ name }) => [
            name,
            db
              .prepare(`SELECT * FROM "${name}"`)
              .all()
              .map((row) => JSON.stringify(row))
              .sort(),
          ]),
      );
    });
  // A normal turn first, so the snapshot holds a used agent's history.
  await ask({});
  const tablesBefore = snapshotTables();
  const filesBefore = snapshotFiles(workspace);

  runAgentMock.mockClear();
  const res = await ask({ 'x-hybridclaw-eval-profile': 'dry-run' });

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).choices[0].message.content).toBe(
    'Order 42 ships on Friday.',
  );
  const agentRequest = runAgentMock.mock.calls[0][0];
  expect(agentRequest.dryRun).toBe(true);
  expect(agentRequest.approvalMode).toBe('auto');
  expect(JSON.stringify(agentRequest.messages)).toContain('Let me check.');

  await flushTokenUsageBuffer();
  await flushAuditTrail();
  expect(snapshotTables()).toEqual(tablesBefore);
  expect(snapshotFiles(workspace)).toEqual(filesBefore);

  const sessionId = res.headers['x-hybridclaw-session-id'];
  expect(
    withMemoryDatabase((db) =>
      db
        .prepare(
          'SELECT input_tokens, output_tokens FROM usage_events WHERE session_id = ?',
        )
        .all(sessionId),
    ),
  ).toEqual([{ input_tokens: 120, output_tokens: 8 }]);
  const turnStart = getRecentStructuredAuditForSession(sessionId, 50).find(
    (entry) => entry.event_type === 'turn.start',
  );
  expect(JSON.parse(turnStart?.payload ?? '{}').dryRun).toBe(true);
});

test('a dry run for an agent without a workspace is refused and creates nothing', async () => {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.js');
  const { withMemoryDatabase } = await import('../src/memory/database.js');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { handleOpenAICompatibleChatCompletions } = await import(
    '../src/gateway/openai-compatible.js'
  );
  initDatabase({ quiet: true });
  const res = makeResponse();
  await handleOpenAICompatibleChatCompletions(
    makeRequest(
      {
        model: 'openai-codex/gpt-5-codex',
        messages: [{ role: 'user', content: 'When does order 42 ship?' }],
      },
      { 'x-hybridclaw-eval-profile': 'agent=suport-desk,dry-run' },
    ) as never,
    res as never,
  );

  expect(res.statusCode).toBe(400);
  expect(runAgentMock).not.toHaveBeenCalled();
  expect(fs.existsSync(path.dirname(agentWorkspaceDir('suport-desk')))).toBe(
    false,
  );
  expect(
    withMemoryDatabase((db) =>
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ),
  ).toEqual({ count: 0 });
});
