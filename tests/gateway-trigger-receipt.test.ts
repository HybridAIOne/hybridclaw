import path from 'node:path';
import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hy-trigger-receipt-',
});

test.each([
  ['add', 'changed'],
  ['remove', 'changed'],
  ['list', 'read'],
  [' add ', 'changed'],
  [' remove ', 'changed'],
  [' list ', 'read'],
] as const)(
  '%s is recorded as %s in live and stored receipts',
  async (action, kind) => {
    const home = setupHome();
    const { TrustedAgentApprovalRuntime } = await import(
      '../container/src/approval-policy.js'
    );
    const { initDatabase } = await import('../src/memory/db.js');
    const { turnReceiptFromExecutions, turnReceiptForMessage } = await import(
      '../src/gateway/turn-receipt.js'
    );
    const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
      '../src/audit/audit-events.js'
    );
    const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
    initDatabase({ quiet: true });
    const runtime = new TrustedAgentApprovalRuntime(
      path.join(home, 'policy.yaml'),
      path.join(home, 'agent-trust.json'),
      path.join(home, 'all-trust.json'),
      path.join(home, 'legacy-trust.json'),
      undefined,
      path.join(home, 'pending.json'),
    );
    const argsJson = JSON.stringify({
      action,
      title: 'File receipts',
      on: 'mail',
      prompt: 'Save new receipts.',
      taskId: 1,
    });
    for (const mode of ['ask', 'auto', 'full'] as const) {
      runtime.setApprovalMode({ mode });
      expect(
        runtime.evaluateToolCall({ toolName: 'trigger', argsJson }),
      ).toMatchObject({
        writeIntent: kind === 'changed',
        baseTier: mode === 'ask' ? 'red' : 'yellow',
      });
    }
    const evaluation = runtime.evaluateToolCall({
      toolName: 'trigger',
      argsJson,
    });
    for (const [index, isError] of [false, true].entries()) {
      const executions = [
        {
          name: 'trigger',
          arguments: argsJson,
          result: isError ? 'Error: Forbidden.' : 'ok',
          durationMs: 5,
          isError,
          blocked: false,
          approvalTier: evaluation.tier,
          approvalBaseTier: evaluation.baseTier,
          approvalDecision: evaluation.decision,
          writeIntent: evaluation.writeIntent,
        },
      ];
      const live = turnReceiptFromExecutions(executions);
      expect(live.items).toEqual([
        expect.objectContaining({
          tool: 'trigger',
          kind,
          ok: !isError,
          blocked: false,
        }),
      ]);
      const sessionId = 'trigger-receipt-chat';
      const runId = `trigger-${action}-${index}`;
      const messageId = index + 1;
      emitToolExecutionAuditEvents({
        sessionId,
        runId,
        toolExecutions: executions,
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex: messageId,
          finishReason: 'completed',
          assistantMessageId: messageId,
        },
      });
      await flushAuditTrail();
      expect(turnReceiptForMessage(sessionId, messageId)).toEqual(live);
    }
  },
);
