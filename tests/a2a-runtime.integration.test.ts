import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;
const ORIGINAL_DISCOVERY_ZONE = process.env.HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE;

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
  delete process.env.HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE;
  vi.resetModules();
});

afterEach(() => {
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_INSTANCE_ID', ORIGINAL_INSTANCE_ID);
  restoreEnvVar('HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE', ORIGINAL_DISCOVERY_ZONE);
  vi.doUnmock('../src/logger.js');
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
    expect(() => runtime.inboxThreads('  ')).toThrow(
      envelope.A2AEnvelopeValidationError,
    );
    expect(() => runtime.inboxThreads('  ')).toThrow(
      'Invalid A2A envelope: agentId is required',
    );
  });

  test('delivers a message from stub agent A to stub agent B inbox', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const store = await import('../src/a2a/store.ts');
    const revisions = await import('../src/config/runtime-config-revisions.ts');

    initDatabase({ quiet: true });
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
      sender_instance_id: 'local-dev',
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
    expect(store.listA2AThreads()).toEqual([
      expect.objectContaining({
        thread_id: 'thread-1',
        owner_coworker_id: 'stub-b@team@local-dev',
      }),
    ]);
    expect(runtime.inboxThreads('stub-b')).toEqual([
      expect.objectContaining({
        thread_id: 'thread-1',
        owner_coworker_id: 'stub-b@team@local-dev',
        latest_intent: 'handoff',
      }),
    ]);
    expect(runtime.inboxThreads('stub-a')).toEqual([]);
    const persistedState = JSON.parse(
      revisions.getRuntimeAssetRevisionState(
        'a2a',
        store.a2aThreadAssetPath('thread-1'),
      )?.content ?? '{}',
    );
    expect(persistedState).toMatchObject({
      thread_id: 'thread-1',
      owner_coworker_id: 'stub-b@team@local-dev',
      envelopes: [deliveredEnvelope],
    });
  });

  test('writes A2A message events to the hash-chain audit wire log', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const audit = await import('../src/audit/audit-trail.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const runtime = await import('../src/a2a/runtime.ts');

    initDatabase({ quiet: true });
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'main', owner: 'team', role: 'lead' },
        { id: 'stub-a', owner: 'team', role: 'sender' },
        { id: 'stub-b', owner: 'team', role: 'recipient' },
      ];
    });

    runtime.sendMessage(
      {
        id: 'msg-audit',
        sender_agent_id: 'stub-a',
        recipient_agent_id: 'stub-b',
        thread_id: 'thread-audit',
        intent: 'handoff',
        content: 'Please pick this up.',
        created_at: '2026-05-01T10:00:00.000Z',
      },
      {
        actor: 'stub-a',
        sessionId: 'session-a2a-audit',
        auditRunId: 'run-a2a-audit',
      },
    );

    const wirePath = audit.getAuditWirePath('session-a2a-audit');
    const lines = fs
      .readFileSync(wirePath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    const records = lines.slice(1).map((line) => JSON.parse(line));

    expect(records.map((record) => record.event.type)).toEqual([
      'a2a.send',
      'a2a.deliver',
      'a2a.handoff',
    ]);
    expect(records[0].event.envelope).toEqual(
      expect.objectContaining({
        messageId: 'msg-audit',
        threadId: 'thread-audit',
        senderAgentId: 'stub-a@team@local-dev',
        recipientAgentId: 'stub-b@team@local-dev',
      }),
    );
    expect(records[0].event.envelope).not.toHaveProperty('content');
    expect(records[1]._prevHash).toBe(records[0]._hash);
    expect(records[2]._prevHash).toBe(records[1]._hash);

    expect(audit.verifyAuditSessionChain('session-a2a-audit')).toMatchObject({
      ok: true,
      checkedRecords: 3,
      errors: [],
      lastSeq: 3,
    });
  });

  test('inbound handoffs audit receive without a local send event', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const audit = await import('../src/audit/audit-trail.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const inbound = await import('../src/a2a/inbound-pipeline.ts');

    initDatabase({ quiet: true });
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'main', owner: 'team', role: 'lead' },
        { id: 'stub-b', owner: 'team', role: 'recipient' },
      ];
    });

    inbound.acceptA2AInboundEnvelope(
      {
        id: 'msg-inbound-audit',
        sender_agent_id: 'remote@team@peer-instance',
        recipient_agent_id: 'stub-b',
        thread_id: 'thread-inbound-audit',
        intent: 'handoff',
        content: 'Remote peer is handing this off.',
        created_at: '2026-05-01T10:00:00.000Z',
      },
      {
        actor: 'trusted-peer',
        source: 'a2a',
        sessionId: 'session-a2a-inbound-audit',
        auditRunId: 'run-a2a-inbound-audit',
      },
    );

    const records = fs
      .readFileSync(
        audit.getAuditWirePath('session-a2a-inbound-audit'),
        'utf-8',
      )
      .split('\n')
      .filter(Boolean)
      .slice(1)
      .map((line) => JSON.parse(line));

    expect(records.map((record) => record.event.type)).toEqual([
      'a2a.deliver',
      'a2a.handoff',
    ]);
    expect(records[0].event.actor).toBe('a2a:trusted-peer');
    expect(records[0].event.envelope).toEqual(
      expect.objectContaining({
        messageId: 'msg-inbound-audit',
        senderAgentId: 'remote@team@peer-instance',
        recipientAgentId: 'stub-b@team@local-dev',
      }),
    );
    expect(
      audit.verifyAuditSessionChain('session-a2a-inbound-audit'),
    ).toMatchObject({
      ok: true,
      checkedRecords: 2,
      errors: [],
      lastSeq: 2,
    });
  });

  test('does not audit outbound queued transport sends as delivered', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const { listA2AOutboxItems } = await import('../src/a2a/a2a-outbound.ts');
    const audit = await import('../src/audit/audit-trail.ts');
    const runtime = await import('../src/a2a/runtime.ts');

    initDatabase({ quiet: true });
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [{ id: 'main', owner: 'team', role: 'lead' }];
    });

    const confirmation = runtime.sendMessage(
      {
        id: 'msg-queued-audit',
        sender_agent_id: 'main',
        recipient_agent_id: 'remote@team@peer-instance',
        thread_id: 'thread-queued-audit',
        intent: 'chat',
        content: 'Queue this for the remote peer.',
        created_at: '2026-05-01T10:00:00.000Z',
      },
      {
        sessionId: 'session-a2a-queued-audit',
        auditRunId: 'run-a2a-queued-audit',
        peerDescriptor: {
          transport: 'a2a',
          url: 'http://127.0.0.1:65535/a2a',
        },
      },
    );

    expect(confirmation).toMatchObject({
      delivered: 'pending',
      message_id: 'msg-queued-audit',
    });
    expect(runtime.inbox('remote@team@peer-instance')).toEqual([]);

    const [outboxItem] = listA2AOutboxItems();
    expect(outboxItem?.envelope).toMatchObject({
      id: 'msg-queued-audit',
      sender_agent_id: 'main@team@local-dev',
      sender_instance_id: 'local-dev',
      recipient_agent_id: 'remote@team@peer-instance',
    });

    const wirePath = audit.getAuditWirePath('session-a2a-queued-audit');
    const records = fs
      .readFileSync(wirePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(1)
      .map((line) => JSON.parse(line));

    expect(records.map((record) => record.event.type)).toEqual(['a2a.send']);
    expect(records[0].event.transport).toBe('a2a');
    expect(records[0].event.envelope).toEqual(
      expect.objectContaining({
        messageId: 'msg-queued-audit',
        senderAgentId: 'main@team@local-dev',
        recipientAgentId: 'remote@team@peer-instance',
      }),
    );
    expect(
      audit.verifyAuditSessionChain('session-a2a-queued-audit'),
    ).toMatchObject({
      ok: true,
      checkedRecords: 1,
      errors: [],
      lastSeq: 1,
    });
  });

  test('warns once when remote canonical sends are queued without identity discovery', async () => {
    const loggerMock = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    vi.doMock('../src/logger.js', () => ({
      logger: loggerMock,
    }));
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');

    initDatabase({ quiet: true });

    for (const id of ['msg-no-discovery-a', 'msg-no-discovery-b']) {
      expect(
        runtime.sendMessage({
          id,
          sender_agent_id: 'main',
          recipient_agent_id: 'remote@team@peer-instance',
          thread_id: 'thread-no-discovery',
          intent: 'chat',
          content: 'Queue this for identity discovery.',
          created_at: '2026-05-01T10:00:00.000Z',
        }),
      ).toMatchObject({
        delivered: 'pending',
        recipient_agent_id: 'remote@team@peer-instance',
      });
    }

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      {
        recipientAgentId: 'remote@team@peer-instance',
        env: 'HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE',
      },
      'A2A remote send queued without identity discovery configured',
    );
  });

  test('audits and escalates when a peer transport has no adapter', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const escalation = await import('../src/gateway/interactive-escalation.ts');
    const runtime = await import('../src/a2a/runtime.ts');

    initDatabase({ quiet: true });

    const confirmation = runtime.sendMessage(
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
    );

    expect(confirmation).toMatchObject({
      delivered: false,
      message_id: 'msg-remote',
      thread_id: 'thread-remote',
      recipient_agent_id: 'remote@team@peer-instance',
      failure_reason: 'No A2A transport adapter registered for "smtp".',
    });

    const events = getRecentStructuredAuditForSession(
      'session-a2a-transport',
      10,
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'escalation.interaction_needed',
      'browser.escalation_2fa',
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

    initDatabase({ quiet: true });

    const confirmation = runtime.sendMessage(
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
    );

    expect(confirmation.delivered).toBe(false);

    const threadKey = Buffer.from('thread:remote').toString('base64url');
    const messageKey = Buffer.from('msg:remote').toString('base64url');
    const suspended = escalation.getSuspendedSession(`a2a:${threadKey}`);

    expect(suspended).toMatchObject({
      approvalId: `a2a-transport-smtp-${messageKey}`,
      status: 'pending',
    });
  });
});
