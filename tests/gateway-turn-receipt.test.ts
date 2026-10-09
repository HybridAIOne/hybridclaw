import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-turn-receipt-',
});

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  const { turnReceiptForMessage, turnReceiptFromExecutions } = await import(
    '../src/gateway/turn-receipt.ts'
  );
  initDatabase({ quiet: true });
  type Execution = Parameters<typeof turnReceiptFromExecutions>[0][number];
  const calls = (executions: Partial<Execution>[]): Execution[] =>
    executions.map(
      (execution) =>
        ({
          name: 'read',
          arguments: '{}',
          result: 'ok',
          durationMs: 5,
          isError: false,
          blocked: false,
          approvalTier: 'green',
          approvalBaseTier: 'green',
          approvalDecision: 'auto',
          writeIntent: false,
          ...execution,
        }) as Execution,
    );
  // Stores one turn's calls the way a turn does, ending in this message.
  const store = async (
    sessionId: string,
    runId: string,
    messageId: number,
    executions: Execution[],
  ) => {
    emitToolExecutionAuditEvents({ sessionId, runId, toolExecutions: executions });
    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'completed',
        assistantMessageId: messageId,
      },
    });
    await flushAuditTrail();
  };
  return { calls, store, turnReceiptForMessage, turnReceiptFromExecutions };
}

const MAIL_READ = {
  name: 'hybridai__google__search_mail',
  arguments: JSON.stringify({ query: 'from:pat@example.com invoice' }),
} as const;

const MAIL_SEND = {
  name: 'hybridai__google__send_mail',
  arguments: JSON.stringify({
    to: ['pat@example.com'],
    subject: 'See you Friday',
    body: 'See you then.',
  }),
  approvalTier: 'red',
  approvalBaseTier: 'red',
  approvalDecision: 'approved_once',
  writeIntent: true,
} as const;

test('a turn lists what it read, sent and changed, and no mail text or address', async () => {
  const { calls, turnReceiptFromExecutions } = await load();
  const receipt = turnReceiptFromExecutions(
    calls([
      // Bookkeeping is no read.
      { name: 'proof', arguments: '{"confirmed":true}' },
      MAIL_READ,
      MAIL_SEND,
      {
        name: 'write',
        arguments: JSON.stringify({ path: 'notes/friday.md', content: 'x' }),
        approvalTier: 'yellow',
        writeIntent: true,
      },
      // A scroll says nothing on its own.
      { name: 'browser_scroll', arguments: '{}' },
    ]),
  );
  expect(receipt).toEqual({
    version: 1,
    more: 0,
    items: [
      {
        kind: 'read',
        tool: 'hybridai__google__search_mail',
        service: 'google',
        target: 'from:… invoice',
        to: [],
        count: 1,
        ok: true,
        blocked: false,
        error: null,
        proof: null,
      },
      {
        kind: 'sent',
        tool: 'hybridai__google__send_mail',
        service: 'google',
        target: 'See you Friday',
        to: ['@example.com'],
        count: 1,
        ok: true,
        blocked: false,
        error: null,
        proof: expect.objectContaining({
          status: 'confirmed',
          evidence: 'service',
        }),
      },
      expect.objectContaining({
        kind: 'changed',
        tool: 'write',
        target: 'notes/friday.md',
        ok: true,
        proof: null,
      }),
    ],
  });
  expect(JSON.stringify(receipt)).not.toContain('See you then.');
  expect(JSON.stringify(receipt)).not.toContain('pat@');
});

test('a failed send, a page it could not read and a refused call show as not done', async () => {
  const { calls, turnReceiptFromExecutions } = await load();
  const receipt = turnReceiptFromExecutions(
    calls([
      {
        name: 'web_fetch',
        arguments: JSON.stringify({ url: 'https://shop.example/terms' }),
        isError: true,
        result: 'Error: 403 Forbidden',
      },
      { ...MAIL_SEND, isError: true, result: 'Error: quota exceeded' },
      {
        ...MAIL_SEND,
        blocked: true,
        approvalDecision: 'denied',
        result: 'You said no.',
      },
      // Waiting for a yes is the approval card's, not the receipt's.
      { ...MAIL_SEND, blocked: true, approvalDecision: 'required' },
    ]),
  );
  expect(
    receipt?.items.map(({ kind, ok, blocked, error }) => ({
      kind,
      ok,
      blocked,
      error,
    })),
  ).toEqual([
    { kind: 'read', ok: false, blocked: false, error: 'Error: 403 Forbidden' },
    { kind: 'sent', ok: false, blocked: false, error: 'Error: quota exceeded' },
    { kind: 'sent', ok: false, blocked: true, error: 'You said no.' },
  ]);
  expect(receipt?.items.every((item) => item.proof === null)).toBe(true);
});

test('an order in the browser needs a check after it, or it is unconfirmed', async () => {
  const { calls, turnReceiptFromExecutions } = await load();
  const order = {
    name: 'browser_click',
    arguments: JSON.stringify({ ref: 'e12' }),
    approvalTier: 'red',
    approvalBaseTier: 'red',
    approvalDecision: 'approved_once',
    writeIntent: true,
  } as const;
  const unconfirmed = turnReceiptFromExecutions(calls([order]));
  expect(unconfirmed?.items[0]).toMatchObject({
    kind: 'changed',
    service: 'browser',
    proof: { status: 'unconfirmed' },
  });
  const confirmed = turnReceiptFromExecutions(
    calls([
      order,
      {
        name: 'browser_snapshot',
        arguments: '{}',
      },
      {
        name: 'proof',
        arguments: JSON.stringify({
          confirmed: true,
          evidence: 'page',
          summary: 'Order 4711 confirmed',
        }),
      },
    ]),
  );
  expect(confirmed?.items).toHaveLength(1);
  expect(confirmed?.items[0].proof).toMatchObject({
    status: 'confirmed',
    evidence: 'page',
    summary: 'Order 4711 confirmed',
  });
});

test('identical reads count once, and a turn with nothing to show has an empty receipt', async () => {
  const { calls, turnReceiptFromExecutions } = await load();
  const page = {
    name: 'web_fetch',
    arguments: JSON.stringify({ url: 'https://example.com/menu' }),
  };
  const receipt = turnReceiptFromExecutions(calls([page, page, page]));
  expect(receipt?.items).toHaveLength(1);
  expect(receipt?.items[0]).toMatchObject({ kind: 'read', count: 3 });
  const empty = { version: 1, items: [], more: 0 };
  expect(
    turnReceiptFromExecutions(calls([{ name: 'proof', arguments: '{}' }])),
  ).toEqual(empty);
  expect(turnReceiptFromExecutions([])).toEqual(empty);
});

test('past the limit, reads are left out before anything sent or changed', async () => {
  const { calls, turnReceiptFromExecutions } = await load();
  const reads = Array.from({ length: 40 }, (_, index) => ({
    name: 'web_fetch',
    arguments: JSON.stringify({ url: `https://example.com/${index}` }),
  }));
  const receipt = turnReceiptFromExecutions(calls([...reads, MAIL_SEND]));
  expect(receipt?.items).toHaveLength(30);
  expect(receipt?.more).toBe(11);
  expect(receipt?.items.at(-1)?.kind).toBe('sent');
});

test('a stored reply gets the same receipt from its run in the audit', async () => {
  const { calls, store, turnReceiptForMessage, turnReceiptFromExecutions } =
    await load();
  const executions = calls([
    MAIL_READ,
    MAIL_SEND,
    {
      name: 'web_fetch',
      arguments: JSON.stringify({ url: 'https://example.com/a' }),
      isError: true,
      result: 'Error: timeout',
    },
  ]);
  await store('app-main', 'run-7', 42, executions);
  await store('app-main', 'run-8', 43, calls([MAIL_READ]));
  const live = turnReceiptFromExecutions(executions);
  const stored = turnReceiptForMessage('app-main', 42);
  expect(stored?.items.map((item) => item.kind)).toEqual([
    'read',
    'sent',
    'read',
  ]);
  expect(stored?.items[1]).toEqual(live?.items[1]);
  expect(stored?.items[2]).toMatchObject({ ok: false, error: 'Error: timeout' });
  expect(turnReceiptForMessage('app-main', 43)?.items).toHaveLength(1);
  // Another chat's message id finds nothing.
  expect(turnReceiptForMessage('app-other', 42)).toBeNull();
  expect(turnReceiptForMessage('app-main', 99)).toBeNull();
});
