import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('approval-learning-audit-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
});

test.each(['succeeded', 'error', 'blocked'] as const)(
  'persists and exports a learning flag with actual outcome %s',
  async (outcome) => {
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp());
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.js'
    );
    const { emitToolExecutionAuditEvents } = await import(
      '../src/audit/audit-events.js'
    );
    const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
    const { mapAuditRowToEvent } = await import(
      '../src/audit/observability-events.js'
    );
    initDatabase({ quiet: true });
    emitToolExecutionAuditEvents({
      sessionId: 'test-session',
      runId: 'test-run',
      toolExecutions: [
        {
          name: 'http_request',
          arguments: JSON.stringify({
            url: 'https://example.com',
            headers: { Authorization: 'Bearer test-secret' },
          }),
          result: 'result',
          durationMs: 3,
          blocked: outcome === 'blocked',
          isError: outcome !== 'succeeded',
          approvalTier: 'red',
          approvalDecision: outcome === 'blocked' ? 'denied' : 'auto',
          approvalObservation: {
            decision: 'required',
            tier: 'red',
            pinned: true,
            reason: 'Protected operation',
          },
        },
      ],
    });
    await flushAuditTrail();
    const rows = getRecentStructuredAuditForSession('test-session', 30);
    const observed = rows.filter(
      (row) => row.event_type === 'approval.observed',
    );
    expect(observed).toHaveLength(1);
    const payload = JSON.parse(observed[0].payload);
    expect(payload).toMatchObject({
      mode: 'learning',
      wouldDecision: 'required',
      tier: 'red',
      pinned: true,
      outcome,
      toolCallId: 'test-run:tool:1',
    });
    expect(observed[0].payload).not.toContain('test-secret');
    expect(
      mapAuditRowToEvent('node-test', 'agent-test', observed[0]),
    ).toMatchObject({
      event_type: 'approval.observed',
      denied: false,
      payload,
    });
    expect(
      rows
        .filter((row) => row.event_type === 'approval.response')
        .some((row) => JSON.parse(row.payload).approvedBy === 'local-user'),
    ).toBe(false);
  },
);
