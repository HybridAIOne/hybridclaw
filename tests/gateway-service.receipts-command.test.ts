import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-receipts-',
});

const APP_CHAT = 'app-main';
const OTHER_APP_CHAT = 'app-other';
const PEER_CHAT = 'peer-chat';

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { emitToolExecutionAuditEvents } = await import(
    '../src/audit/audit-events.ts'
  );
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  const { scheduledRunSessionKey } = await import(
    '../src/session/session-key.ts'
  );
  initDatabase({ quiet: true });

  const run = async (sessionId: string, args: string[], channelId = 'web') => {
    const result = await handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId,
      args,
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { text: result.text, json };
  };

  let runs = 0;
  type Execution = Parameters<
    typeof emitToolExecutionAuditEvents
  >[0]['toolExecutions'][number];
  const act = async (sessionId: string, execution: Partial<Execution>) => {
    runs += 1;
    emitToolExecutionAuditEvents({
      sessionId,
      runId: `run-${runs}`,
      toolExecutions: [
        {
          name: 'hybridai__google__send_mail',
          arguments: '{}',
          result: 'ok',
          durationMs: 5,
          isError: false,
          blocked: false,
          approvalTier: 'red',
          approvalBaseTier: 'red',
          approvalDecision: 'approved_once',
          approvalActionKey: 'mcp:hybridai:other:google__send_mail',
          approvalIntent: 'run MCP tool Send mail',
          escalationRoute: 'approval_request',
          ...execution,
        } as Execution,
      ],
    });
    await flushAuditTrail();
  };

  // One turn's tool calls, in order; each is a plain successful call unless
  // it says otherwise.
  const turn = async (sessionId: string, executions: Partial<Execution>[]) => {
    runs += 1;
    emitToolExecutionAuditEvents({
      sessionId,
      runId: `run-${runs}`,
      toolExecutions: executions.map(
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
            escalationRoute: 'none',
            ...execution,
          }) as Execution,
      ),
    });
    await flushAuditTrail();
  };

  return { run, act, turn, scheduledRunSessionKey };
}

// An order placed in the browser, which the user allowed.
const ORDER = {
  name: 'browser_click',
  arguments: JSON.stringify({ ref: 'e12' }),
  approvalTier: 'red',
  approvalBaseTier: 'red',
  approvalDecision: 'approved_once',
  approvalIntent: 'place an order on shop.example (button "Buy now")',
  escalationRoute: 'approval_request',
} as const;

const proof = (args: Record<string, unknown>, result = '{"recorded":true}') =>
  ({ name: 'proof', arguments: JSON.stringify(args), result }) as const;

test('a sent mail is a receipt with its recipient, and who allowed it', async () => {
  const { run, act } = await load();
  // Sessions exist once a chat has used them.
  await run(APP_CHAT, ['receipts']);
  await act(APP_CHAT, {
    arguments: JSON.stringify({
      to: 'service@aa.com, refunds@aa.com',
      subject: 'Credit extension',
      body: 'Please extend my credit.',
    }),
  });

  const answer = await run(APP_CHAT, ['receipts', '--json']);
  expect(answer.json).toMatchObject({
    version: 1,
    receipts: [
      {
        session: APP_CHAT,
        task: null,
        tool: 'hybridai__google__send_mail',
        service: 'google',
        action: 'run MCP tool Send mail',
        to: ['@aa.com'],
        subject: 'Credit extension',
        allowed: 'you',
        ok: true,
        error: null,
        // Google's own tool said it went out.
        proof: { status: 'confirmed', evidence: 'service' },
      },
    ],
  });
  // A receipt never carries what was written, nor an address.
  expect(answer.text).not.toContain('Please extend');
  expect(answer.text).not.toContain('service@');
  const text = await run(APP_CHAT, ['receipts']);
  expect(text.text).toContain('to @aa.com');
  expect(text.text).toContain('you allowed it');
});

test('reads, waiting and denied actions are no receipts', async () => {
  const { run, act } = await load();
  await run(APP_CHAT, ['receipts']);
  await act(APP_CHAT, {
    name: 'read',
    approvalTier: 'green',
    approvalBaseTier: 'green',
    approvalDecision: 'auto',
    escalationRoute: 'none',
  });
  await act(APP_CHAT, {
    approvalDecision: 'required',
    blocked: true,
    result: 'I need your approval',
  });
  await act(APP_CHAT, {
    approvalDecision: 'denied',
    blocked: true,
  });

  const answer = await run(APP_CHAT, ['receipts', '--json']);
  expect(answer.json).toEqual({ version: 1, receipts: [] });
  expect((await run(APP_CHAT, ['receipts'])).text).toBe(
    'Nothing done outside the sandbox yet.',
  );
});

test('an app sees its web chats and its tasks, a peer only its own', async () => {
  const { run, act, scheduledRunSessionKey } = await load();
  await run(APP_CHAT, ['receipts']);
  await run(OTHER_APP_CHAT, ['receipts']);
  await run(PEER_CHAT, ['receipts'], 'discord');
  const added = await run(APP_CHAT, [
    'schedule',
    'add',
    '--json',
    '--reply-only',
    '"0 8 * * *"',
    'Look at my mail',
  ]);
  const taskId = (added.json.task as { id: number }).id;

  await act(OTHER_APP_CHAT, {
    name: 'hybridai__google__create_event',
    arguments: JSON.stringify({
      summary: 'Dentist',
      start: { dateTime: '2026-10-05T09:00:00+02:00' },
      attendees: ['x@example.com'],
    }),
    approvalDecision: 'approved_session',
  });
  await act(scheduledRunSessionKey('main', taskId), {
    arguments: JSON.stringify({ to: ['me@example.com'], subject: 'Digest' }),
    approvalDecision: 'approved_agent',
  });
  await act(PEER_CHAT, {
    arguments: JSON.stringify({ to: 'peer@example.com', subject: 'Peer' }),
  });
  await act(APP_CHAT, {
    arguments: JSON.stringify({ to: 'x@example.com', subject: 'Bounced' }),
    approvalDecision: 'approved_fullauto',
    isError: true,
    result: 'Mailbox unavailable',
  });

  const app = (await run(APP_CHAT, ['receipts', '--json'])).json
    .receipts as Array<Record<string, unknown>>;
  expect(app.map((receipt) => receipt.subject ?? receipt.title)).toEqual([
    'Bounced',
    'Digest',
    'Dentist',
  ]);
  expect(app[0]).toMatchObject({
    allowed: 'full',
    ok: false,
    error: 'Mailbox unavailable',
  });
  expect(app[1]).toMatchObject({ task: taskId, allowed: 'earlier' });
  expect(app[2]).toMatchObject({
    session: OTHER_APP_CHAT,
    title: 'Dentist',
    when: '2026-10-05T09:00:00+02:00',
    allowed: 'earlier',
  });

  const peer = (await run(PEER_CHAT, ['receipts', '--json'], 'discord')).json
    .receipts as Array<Record<string, unknown>>;
  expect(peer.map((receipt) => receipt.subject)).toEqual(['Peer']);

  const limited = (await run(APP_CHAT, ['receipts', '--json', '--limit', '1']))
    .json.receipts as unknown[];
  expect(limited).toHaveLength(1);
  expect((await run(APP_CHAT, ['receipts', '--bogus'])).text).toContain(
    'Usage',
  );
});

test('a browser order is confirmed only by a check after it', async () => {
  const { run, turn } = await load();
  await run(APP_CHAT, ['receipts']);
  // Clicked, never checked.
  await turn(APP_CHAT, [ORDER]);
  // Claims a confirmation email it never read.
  await turn(APP_CHAT, [
    ORDER,
    proof({
      confirmed: true,
      evidence: 'email',
      summary: 'Order confirmed',
      from: 'orders@shop.example',
      subject: 'Your order',
    }),
  ]);
  // Read the mail, then recorded it.
  await turn(APP_CHAT, [
    ORDER,
    { name: 'hybridai__google__search_mail' },
    proof({
      confirmed: true,
      evidence: 'email',
      summary: 'Order 4711 confirmed',
      from: 'Shop <orders@shop.example>',
      subject: 'Your order 4711',
    }),
  ]);
  // Took a screenshot, then recorded it.
  await turn(APP_CHAT, [
    ORDER,
    { name: 'browser_screenshot' },
    proof(
      {
        confirmed: true,
        evidence: 'screenshot',
        summary: 'Thank you page, order 4712',
        screenshot: '.browser-artifacts/shot.png',
      },
      '{"recorded":true,"path":"receipts/proof-1000-shot.png"}',
    ),
  ]);
  // Looked and found nothing.
  await turn(APP_CHAT, [
    ORDER,
    { name: 'hybridai__google__search_mail' },
    proof({ confirmed: false, summary: 'No confirmation email yet' }),
  ]);

  const receipts = (await run(APP_CHAT, ['receipts', '--json'])).json
    .receipts as Array<{ proof: Record<string, unknown> }>;
  expect(receipts.map((receipt) => receipt.proof)).toEqual([
    {
      status: 'unconfirmed',
      evidence: null,
      summary: 'No confirmation email yet',
      from: null,
      subject: null,
      path: null,
    },
    {
      status: 'confirmed',
      evidence: 'screenshot',
      summary: 'Thank you page, order 4712',
      from: null,
      subject: null,
      path: 'receipts/proof-1000-shot.png',
    },
    {
      status: 'confirmed',
      evidence: 'email',
      summary: 'Order 4711 confirmed',
      from: '@shop.example',
      subject: 'Your order 4711',
      path: null,
    },
    expect.objectContaining({ status: 'unconfirmed', summary: null }),
    expect.objectContaining({ status: 'unconfirmed', summary: null }),
  ]);
  const text = (await run(APP_CHAT, ['receipts'])).text;
  expect(text).toContain("couldn't confirm it worked");
  expect(text).toContain('confirmed by email: Order 4711 confirmed');
});

test('files the agent wrote need no proof', async () => {
  const { run, turn } = await load();
  await run(APP_CHAT, ['receipts']);
  await turn(APP_CHAT, [
    {
      name: 'write',
      arguments: JSON.stringify({ path: 'notes/plan.md' }),
      approvalDecision: 'approved_once',
      escalationRoute: 'approval_request',
    },
  ]);
  const receipts = (await run(APP_CHAT, ['receipts', '--json'])).json
    .receipts as Array<Record<string, unknown>>;
  expect(receipts).toHaveLength(1);
  expect(receipts[0].proof).toBeNull();
});
