import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-trace-dynamic-context-',
});

test.each([
  {
    label: 'preserves surrounding whitespace',
    content: ' \n<context>\nA current preference.\n</context>\n\t',
    included: true,
  },
  { label: 'omits blank context', content: ' \n\t ', included: false },
])('trace dynamic context $label', async ({ content, included }) => {
  setupHome();
  const {
    getOrCreateSession,
    getStructuredAuditForSession,
    getSessionUsageTotals,
    initDatabase,
    storeMessage,
  } = await import('../src/memory/db.js');
  const { recordAuditEvent } = await import('../src/audit/audit-events.js');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
  const { exportSessionTraceAtifJsonl } = await import(
    '../src/session/session-trace-export.js'
  );
  initDatabase({ quiet: true });
  const session = getOrCreateSession('trace-context', null, 'tui');
  const runId = 'trace-context-run';
  const userMessageId = storeMessage(
    session.id,
    'user_a',
    null,
    'user',
    'Hello',
  );
  const assistantMessageId = storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Done',
  );
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'Hello',
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'agent.start',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      systemPrompt: 'A stable instruction.',
      dynamicContext: content,
      promptMessages: 3,
      scheduledTaskCount: 0,
    },
  });
  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'turn.end',
      turnIndex: 1,
      finishReason: 'completed',
      assistantMessageId,
    },
  });
  await flushAuditTrail();
  const timestamp = new Date().toISOString();
  const exported = await exportSessionTraceAtifJsonl({
    agentId: session.agent_id,
    session,
    messages: [
      {
        id: userMessageId,
        session_id: session.id,
        user_id: 'user_a',
        username: null,
        role: 'user',
        content: 'Hello',
        created_at: timestamp,
      },
      {
        id: assistantMessageId,
        session_id: session.id,
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Done',
        created_at: timestamp,
      },
    ],
    auditEntries: getStructuredAuditForSession(session.id),
    usageTotals: getSessionUsageTotals(session.id),
  });
  expect(exported).not.toBeNull();
  const record = JSON.parse(
    fs.readFileSync(exported?.path ?? '', 'utf-8'),
  ) as { steps: Array<Record<string, unknown>> };
  const step = record.steps.find((item) => item.role === 'agent');
  if (!step) throw new Error('Expected an exported agent step');
  if (included) {
    const expectedHash = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16);
    expect(step.dynamic_context).toEqual({ role: 'user', content });
    expect(step.dynamic_context_hash).toBe(expectedHash);
    expect(step.prompt_prefix).toContainEqual({
      role: 'user',
      kind: 'dynamic_context',
      dynamic_context_hash: expectedHash,
      content,
    });
  } else {
    expect(step).not.toHaveProperty('dynamic_context');
    expect(step).not.toHaveProperty('dynamic_context_hash');
    expect(step.prompt_prefix).toHaveLength(1);
  }
});
