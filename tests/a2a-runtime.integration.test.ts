import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;

let tmpDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-runtime-'));
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
  vi.resetModules();
});

afterEach(() => {
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_INSTANCE_ID', ORIGINAL_INSTANCE_ID);
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('A2A runtime API', () => {
  test('fails fast for invalid runtime boundary inputs', async () => {
    const runtime = await import('../src/a2a/runtime.ts');
    const envelope = await import('../src/a2a/envelope.ts');

    expect(() => runtime.sendMessage(null)).toThrow(
      envelope.A2AEnvelopeValidationError,
    );
    expect(() => runtime.sendMessage(null)).toThrow(
      'Invalid A2A envelope: envelope must be an object',
    );
    expect(() => runtime.inbox('  ')).toThrow(
      envelope.A2AEnvelopeValidationError,
    );
    expect(() => runtime.inbox('  ')).toThrow(
      'Invalid A2A envelope: agentId is required',
    );
    expect(() =>
      runtime.sendMessage({
        id: 'msg-alias',
        sender_coworker_id: 'stub-a',
        recipient_coworker_id: 'stub-b',
        thread_id: 'thread-1',
        intent: 'chat',
        content: 'Old terminology.',
        created_at: '2026-04-29T10:00:00.000Z',
      }),
    ).toThrow('unexpected field: sender_coworker_id');
  });

  test('delivers a message from stub agent A to stub agent B inbox', async () => {
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const runtime = await import('../src/a2a/runtime.ts');

    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'main', owner: 'team', role: 'lead' },
        { id: 'Stub-A', owner: 'team', role: 'sender', reportsTo: 'main' },
        {
          id: 'stub-b',
          owner: 'team',
          role: 'recipient',
          reportsTo: 'main',
          peers: ['Stub-A'],
        },
      ];
    });

    const confirmation = runtime.sendMessage(
      {
        id: 'msg-1',
        sender_agent_id: 'stub-a@team@local-dev',
        recipient_agent_id: 'stub-b',
        thread_id: 'thread-1',
        intent: 'handoff',
        content:
          'Please take over the customer brief.\n\n## Handoff Org Chart Context',
        created_at: '2026-04-29T10:00:00.000Z',
      },
      {
        actor: 'Stub-A',
      },
    );

    expect(confirmation).toMatchObject({
      delivered: true,
      message_id: 'msg-1',
      thread_id: 'thread-1',
      recipient_agent_id: 'stub-b@team@local-dev',
    });
    expect(confirmation).not.toHaveProperty('delivered_at');

    const deliveredEnvelope = {
      id: 'msg-1',
      sender_agent_id: 'stub-a@team@local-dev',
      recipient_agent_id: 'stub-b@team@local-dev',
      thread_id: 'thread-1',
      intent: 'handoff',
      content: expect.stringContaining('Please take over the customer brief.'),
      created_at: '2026-04-29T10:00:00.000Z',
    };
    expect(runtime.inbox('stub-a')).toEqual([]);
    expect(runtime.inbox('stub-b')).toEqual([deliveredEnvelope]);
    const [handoff] = runtime.inbox('stub-b');
    expect(handoff?.content).toContain('## Handoff Org Chart Context');
    expect(handoff?.content).toContain(
      '<!-- hybridclaw:a2a-handoff-org-chart-context:v1 -->',
    );
    expect(handoff?.content).toContain('sender_manager: main (lead)');
    expect(handoff?.content).toContain('recipient_manager: main (lead)');
    expect(handoff?.content).toContain('recipient_peers: Stub-A (sender)');
    expect(handoff?.content).toContain(
      'recipient_escalation_chain: main (lead)',
    );
  });

  test('audits and escalates when a peer transport has no adapter', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const escalation = await import('../src/gateway/interactive-escalation.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');

    initDatabase({ quiet: true });

    expect(() =>
      runtime.sendMessage(
        {
          id: 'msg-remote',
          sender_agent_id: 'main',
          recipient_agent_id: 'remote@team@peer-instance',
          thread_id: 'thread-remote',
          intent: 'chat',
          content: 'Can your peer agent receive this?',
          created_at: '2026-05-01T10:00:00.000Z',
        },
        {
          sessionId: 'session-a2a-transport',
          auditRunId: 'run-a2a-transport',
          peerDescriptor: {
            transport: 'smtp',
          },
          escalationTarget: {
            channel: 'slack:COPS',
            recipient: 'ops-lead',
          },
        },
      ),
    ).toThrow(transport.TransportRegistryError);

    const events = getRecentStructuredAuditForSession(
      'session-a2a-transport',
      10,
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'escalation.interaction_needed',
      'approval.request',
      'escalation.decision',
      'authorization.check',
    ]);
    const escalationEvent = events.find(
      (event) => event.event_type === 'escalation.decision',
    );
    expect(JSON.parse(escalationEvent?.payload || '{}')).toEqual(
      expect.objectContaining({
        type: 'escalation.decision',
        action: 'a2a.transport:smtp',
        escalationRoute: 'approval_request',
        target: {
          channel: 'slack:COPS',
          recipient: 'ops-lead',
        },
        approvalDecision: 'required',
      }),
    );
    const suspended = escalation.getSuspendedSession('session-a2a-transport');
    expect(suspended).toMatchObject({
      approvalId: 'a2a-transport-smtp-msg-remote',
      status: 'pending',
      modality: 'push',
      expectedReturnKinds: ['approved', 'declined', 'timeout'],
      skillId: 'a2a.transport-registry',
      escalationTarget: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
    });
    expect(suspended?.prompt).toContain('no adapter is registered for "smtp"');
  });

  test('encodes envelope ids before composing default escalation keys', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const escalation = await import('../src/gateway/interactive-escalation.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');

    initDatabase({ quiet: true });

    expect(() =>
      runtime.sendMessage(
        {
          id: 'msg:remote',
          sender_agent_id: 'main',
          recipient_agent_id: 'remote@team@peer-instance',
          thread_id: 'thread:remote',
          intent: 'chat',
          content: 'Can your peer agent receive this?',
          created_at: '2026-05-01T10:00:00.000Z',
        },
        {
          auditRunId: 'run-a2a-transport',
          peerDescriptor: {
            transport: 'smtp',
          },
        },
      ),
    ).toThrow(transport.TransportRegistryError);

    const threadKey = Buffer.from('thread:remote').toString('base64url');
    const messageKey = Buffer.from('msg:remote').toString('base64url');
    const suspended = escalation.getSuspendedSession(`a2a:${threadKey}`);

    expect(suspended).toMatchObject({
      approvalId: `a2a-transport-smtp-${messageKey}`,
      status: 'pending',
    });
  });
});
