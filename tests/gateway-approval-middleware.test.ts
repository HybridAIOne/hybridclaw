import { describe, expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-approval-middleware-',
});

describe('gateway approval middleware', () => {
  test('maps approve directives to structured approval responses', async () => {
    setupHome();

    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true });

    const { handleGatewayApprovalCommand } = await import(
      '../src/gateway/approval-middleware.ts'
    );
    const pendingApprovals = await import('../src/gateway/pending-approvals.js');

    for (const scenario of [
      {
        action: 'yes',
        expected: { approvalId: 'approve-1', decision: 'approve', mode: 'once' },
      },
      {
        action: 'session',
        expected: {
          approvalId: 'approve-2',
          decision: 'approve',
          mode: 'session',
        },
      },
      {
        action: 'agent',
        expected: { approvalId: 'approve-3', decision: 'approve', mode: 'agent' },
      },
      {
        action: 'no',
        expected: { approvalId: 'approve-4', decision: 'deny', mode: 'once' },
      },
    ] as const) {
      await pendingApprovals.setPendingApproval(`session:${scenario.action}`, {
        approvalId: scenario.expected.approvalId,
        prompt: `Approval needed for ${scenario.action}`,
        originalUserContent: `Run ${scenario.action}`,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        userId: 'user-1',
        resolvedAt: null,
        disableButtons: null,
        disableTimeout: null,
      });

      const replayMessage = vi.fn(async () => ({
        status: 'success' as const,
        result: 'Replay complete',
        toolsUsed: [],
        artifacts: [],
      }));

      const outcome = await handleGatewayApprovalCommand({
        sessionId: `web:${scenario.action}`,
        guildId: null,
        channelId: 'web',
        userId: 'user-1',
        username: 'alice',
        args: ['approve', scenario.action, scenario.expected.approvalId],
        replayMessage,
      });

      expect(outcome).toMatchObject({
        handled: true,
        kind: 'replayed',
        pendingApproval: null,
        resultText: 'Replay complete',
      });
      expect(replayMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: `Run ${scenario.action}`,
          source: 'approval',
          approvalResponse: scenario.expected,
        }),
      );
      expect(
        pendingApprovals.getPendingApproval(`session:${scenario.action}`),
      ).toBeNull();
    }
  });

  test('stores nested approval requests under the claimed session after replay', async () => {
    setupHome();

    const { initDatabase } = await import('../src/memory/db.ts');
    initDatabase({ quiet: true });

    const { handleGatewayApprovalCommand } = await import(
      '../src/gateway/approval-middleware.ts'
    );
    const pendingApprovals = await import('../src/gateway/pending-approvals.js');

    await pendingApprovals.setPendingApproval('approval-session', {
      approvalId: 'approve-root',
      prompt: 'Approval needed for root request',
      originalUserContent: 'Open X.com notifications',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      userId: 'user-1',
      resolvedAt: null,
      disableButtons: null,
      disableTimeout: null,
    });

    const outcome = await handleGatewayApprovalCommand({
      sessionId: 'web:default',
      guildId: null,
      channelId: 'web',
      userId: 'user-1',
      username: 'alice',
      args: ['approve', 'session', 'approve-root'],
      replayMessage: async () => ({
        status: 'success',
        result: 'Approval needed for: send email',
        toolsUsed: ['message'],
        pendingApproval: {
          approvalId: 'approve-nested',
          prompt: 'Approval needed for: send email',
          intent: 'send email',
          reason: 'this would contact a new external host',
          allowSession: true,
          allowAgent: false,
          expiresAt: Date.now() + 120_000,
        },
        artifacts: [],
      }),
    });

    expect(outcome).toMatchObject({
      handled: true,
      kind: 'replayed',
      pendingApproval: expect.objectContaining({
        approvalId: 'approve-nested',
      }),
    });
    expect(pendingApprovals.getPendingApproval('approval-session')).toMatchObject({
      approvalId: 'approve-nested',
      originalUserContent: 'Open X.com notifications',
      userId: 'user-1',
    });
  });
});
