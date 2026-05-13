import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  A2A_LOCAL_INSTANCE_ID,
  type A2AEnvelopeDuplicateError,
  A2AEnvelopeValidationError,
  classifyA2AAgentId,
  createA2AEnvelope,
  summarizeA2AEnvelopeForAudit,
  validateA2AEnvelope,
} from '../src/a2a/envelope.ts';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;

let tmpDir: string;

function expectEnvelopeValidationIssues(
  value: unknown,
): A2AEnvelopeValidationError {
  try {
    validateA2AEnvelope(value);
  } catch (error) {
    expect(error).toBeInstanceOf(A2AEnvelopeValidationError);
    return error as A2AEnvelopeValidationError;
  }
  throw new Error('Expected validation to fail.');
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-envelope-'));
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

describe('A2A envelope schema', () => {
  test('validates and normalizes local and canonical agent ids', () => {
    const envelope = validateA2AEnvelope({
      id: ' msg-1 ',
      sender_agent_id: ' researcher ',
      recipient_agent_id: 'Charly@Benedikt@Local-Dev',
      thread_id: ' thread-1 ',
      parent_message_id: ' msg-0 ',
      intent: 'handoff',
      content: 'Please take the client brief from here.',
      created_at: '2026-04-28T10:00:00.000Z',
    });

    expect(envelope).toEqual({
      id: 'msg-1',
      sender_agent_id: 'researcher',
      recipient_agent_id: 'charly@benedikt@local-dev',
      sender_instance_id: A2A_LOCAL_INSTANCE_ID,
      thread_id: 'thread-1',
      parent_message_id: 'msg-0',
      intent: 'handoff',
      content: 'Please take the client brief from here.',
      created_at: '2026-04-28T10:00:00.000Z',
    });
    expect(classifyA2AAgentId('researcher')).toBe('local');
    expect(classifyA2AAgentId('charly@benedikt@local-dev')).toBe('canonical');
    expect(classifyA2AAgentId('Charly@Benedikt@Local-Dev')).toBe('canonical');
  });

  test('validates delegation metadata against canonical agent instances', () => {
    const envelope = validateA2AEnvelope({
      id: 'msg-delegate-1',
      sender_agent_id: 'Researcher@Team-A@Inst-Source',
      recipient_agent_id: 'Writer@Team-B@Inst-Target',
      sender_instance_id: ' Inst-Source ',
      source_instance_id: ' Inst-Source ',
      target_instance_id: ' Inst-Target ',
      thread_id: 'thread-delegate',
      intent: 'handoff',
      content: 'Please take this delegated task.',
      created_at: '2026-04-28T10:00:00.000Z',
      delegation_token: 'jwt.header.payload',
    });

    expect(envelope).toEqual({
      id: 'msg-delegate-1',
      sender_agent_id: 'researcher@team-a@inst-source',
      recipient_agent_id: 'writer@team-b@inst-target',
      sender_instance_id: 'inst-source',
      source_instance_id: 'inst-source',
      target_instance_id: 'inst-target',
      thread_id: 'thread-delegate',
      intent: 'handoff',
      content: 'Please take this delegated task.',
      created_at: '2026-04-28T10:00:00.000Z',
      delegation_token: 'jwt.header.payload',
    });

    expect(summarizeA2AEnvelopeForAudit(envelope)).toEqual({
      messageId: 'msg-delegate-1',
      threadId: 'thread-delegate',
      senderAgentId: 'researcher@team-a@inst-source',
      recipientAgentId: 'writer@team-b@inst-target',
      senderInstanceId: 'inst-source',
      sourceInstanceId: 'inst-source',
      targetInstanceId: 'inst-target',
      delegation: true,
    });
  });

  test('derives sender_instance_id from canonical sender ids', () => {
    const envelope = validateA2AEnvelope({
      id: 'msg-federated-1',
      sender_agent_id: 'Remote@Team@Peer-Instance',
      recipient_agent_id: 'main',
      thread_id: 'thread-federated',
      intent: 'chat',
      content: 'Federated hello.',
      created_at: '2026-04-28T10:00:00.000Z',
    });

    expect(envelope).toMatchObject({
      id: 'msg-federated-1',
      sender_agent_id: 'remote@team@peer-instance',
      sender_instance_id: 'peer-instance',
      recipient_agent_id: 'main',
    });
  });

  test('derives sender_instance_id for local compatibility envelopes', () => {
    const envelope = validateA2AEnvelope({
      id: 'msg-local-1',
      sender_agent_id: 'main',
      recipient_agent_id: 'writer',
      thread_id: 'thread-local',
      intent: 'chat',
      content: 'Local compatibility hello.',
      created_at: '2026-04-28T10:00:00.000Z',
    });

    expect(envelope).toMatchObject({
      id: 'msg-local-1',
      sender_agent_id: 'main',
      sender_instance_id: A2A_LOCAL_INSTANCE_ID,
      recipient_agent_id: 'writer',
    });
  });

  test('rejects malformed envelopes', () => {
    const error = expectEnvelopeValidationIssues({
      id: 'bad id',
      sender_agent_id: 'agent@too@many@segments',
      recipient_agent_id: 'writer one',
      thread_id: 'thread-1',
      intent: 'notify',
      content: ['not', 'text'],
      created_at: 'not-a-date',
      extra: true,
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        'unexpected field: extra',
        'id must be a non-empty id without whitespace',
        'sender_agent_id must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
        'recipient_agent_id must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
        'intent must be one of: chat, handoff, escalate, ack, policy.update',
        'content must be a string',
        'created_at must be an ISO timestamp',
      ]),
    );
  });

  test('rejects incomplete or mismatched delegation metadata', () => {
    const incomplete = expectEnvelopeValidationIssues({
      id: 'msg-delegate-bad',
      sender_agent_id: 'main',
      recipient_agent_id: 'writer@team@inst-target',
      source_instance_id: 'inst-source',
      thread_id: 'thread-delegate',
      intent: 'handoff',
      content: 'Bad delegation metadata.',
      created_at: '2026-04-28T10:00:00.000Z',
    });
    expect(incomplete.issues).toEqual(
      expect.arrayContaining([
        'source_instance_id, target_instance_id, and delegation_token must be provided together',
        'sender_agent_id must be canonical when delegation fields are provided',
      ]),
    );

    const invalidSender = expectEnvelopeValidationIssues({
      id: 'msg-delegate-invalid-sender',
      sender_agent_id: 'bad sender',
      recipient_agent_id: 'writer@team@inst-target',
      source_instance_id: 'inst-source',
      target_instance_id: 'inst-target',
      thread_id: 'thread-delegate',
      intent: 'handoff',
      content: 'Bad delegation metadata.',
      created_at: '2026-04-28T10:00:00.000Z',
      delegation_token: 'jwt.header.payload',
    });
    expect(invalidSender.issues).toEqual(
      expect.arrayContaining([
        'sender_agent_id must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
      ]),
    );
    expect(invalidSender.issues).not.toContain(
      'sender_agent_id must be canonical when delegation fields are provided',
    );

    const mismatched = expectEnvelopeValidationIssues({
      id: 'msg-delegate-mismatch',
      sender_agent_id: 'researcher@team@inst-source',
      recipient_agent_id: 'writer@team@inst-target',
      source_instance_id: 'inst-other',
      target_instance_id: 'inst-target',
      thread_id: 'thread-delegate',
      intent: 'handoff',
      content: 'Bad delegation metadata.',
      created_at: '2026-04-28T10:00:00.000Z',
      delegation_token: 'bad token',
    });
    expect(mismatched.issues).toEqual(
      expect.arrayContaining([
        'source_instance_id must match the instance-id portion of sender_agent_id',
        'delegation_token must be a non-empty token without whitespace',
      ]),
    );

    const mismatchedSenderInstance = expectEnvelopeValidationIssues({
      id: 'msg-federation-mismatch',
      sender_agent_id: 'researcher@team@inst-source',
      recipient_agent_id: 'writer@team@inst-target',
      sender_instance_id: 'inst-other',
      thread_id: 'thread-delegate',
      intent: 'chat',
      content: 'Bad federation metadata.',
      created_at: '2026-04-28T10:00:00.000Z',
    });
    expect(mismatchedSenderInstance.issues).toEqual(
      expect.arrayContaining([
        'sender_instance_id must match the instance-id portion of sender_agent_id',
      ]),
    );

    const oversizedToken = expectEnvelopeValidationIssues({
      id: 'msg-delegate-oversized-token',
      sender_agent_id: 'researcher@team@inst-source',
      recipient_agent_id: 'writer@team@inst-target',
      source_instance_id: 'inst-source',
      target_instance_id: 'inst-target',
      thread_id: 'thread-delegate',
      intent: 'handoff',
      content: 'Bad delegation metadata.',
      created_at: '2026-04-28T10:00:00.000Z',
      delegation_token: 'a'.repeat(8193),
    });
    expect(oversizedToken.issues).toEqual(
      expect.arrayContaining([
        'delegation_token must be at most 8192 characters',
      ]),
    );
  });

  test('creates envelopes with generated ids and timestamps', () => {
    const envelope = createA2AEnvelope({
      sender_agent_id: 'main',
      recipient_agent_id: 'writer',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Draft the outline.',
    });

    expect(envelope.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Date.parse(envelope.created_at)).not.toBeNaN();
  });
});

describe('A2A envelope persistence', () => {
  test('round-trips envelopes through the revisioned runtime store', async () => {
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const store = await import('../src/a2a/store.ts');
    const revisions = await import('../src/config/runtime-config-revisions.ts');

    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        { id: 'main', owner: 'benedikt' },
        { id: 'writer', owner: 'sam' },
      ];
    });

    const first = validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'Main',
      recipient_agent_id: 'writer@benedikt@local-dev',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Can you draft this?',
      created_at: '2026-04-28T10:00:00.000Z',
    });
    const second = validateA2AEnvelope({
      id: 'msg-2',
      sender_agent_id: 'writer@benedikt@local-dev',
      recipient_agent_id: 'main',
      thread_id: 'thread-1',
      parent_message_id: 'msg-1',
      intent: 'ack',
      content: '',
      created_at: '2026-04-28T10:01:00.000Z',
    });

    const resolvedFirst = {
      ...first,
      sender_agent_id: 'main@benedikt@local-dev',
      sender_instance_id: 'local-dev',
    };
    const resolvedSecond = {
      ...second,
      sender_instance_id: 'local-dev',
      recipient_agent_id: 'main@benedikt@local-dev',
    };

    expect(store.listA2AThreadEnvelopes('thread-1')).toEqual([]);
    expect(
      store.saveA2AEnvelope(first, {
        actor: 'test',
        route: 'test.a2a.first',
        source: 'internal',
      }),
    ).toEqual(resolvedFirst);
    expect(store.getA2AEnvelope('thread-1', 'msg-1')).toEqual(resolvedFirst);

    store.saveA2AEnvelope(second, {
      actor: 'test',
      route: 'test.a2a.second',
      source: 'internal',
    });

    expect(store.listA2AThreadEnvelopes('thread-1')).toEqual([
      resolvedFirst,
      resolvedSecond,
    ]);

    const assetPath = store.a2aThreadAssetPath('thread-1');
    expect(assetPath).toBe(
      path.join(tmpDir, 'a2a', 'threads', 'thread-1.json'),
    );
    const state = revisions.getRuntimeAssetRevisionState('a2a', assetPath);
    const stateContent = state?.content ?? '{}';
    expect(JSON.parse(stateContent)).toMatchObject({
      version: 1,
      thread_id: 'thread-1',
      envelopes: [resolvedFirst, resolvedSecond],
    });
    expect(stateContent).toBe(JSON.stringify(JSON.parse(stateContent)));

    const revisionSummaries = revisions.listRuntimeAssetRevisions(
      'a2a',
      assetPath,
    );
    expect(revisionSummaries).toHaveLength(1);
    expect(revisionSummaries[0]).toMatchObject({
      assetType: 'a2a',
      route: 'test.a2a.second',
    });
    const revision = revisions.getRuntimeAssetRevision(
      'a2a',
      assetPath,
      revisionSummaries[0]?.id ?? -1,
    );
    expect(JSON.parse(revision?.content ?? '{}')).toMatchObject({
      version: 1,
      thread_id: 'thread-1',
      envelopes: [resolvedFirst],
    });
  });

  test('hydrates sender_instance_id from legacy canonical persisted envelopes without rewriting state', async () => {
    const store = await import('../src/a2a/store.ts');
    const revisions = await import('../src/config/runtime-config-revisions.ts');
    const legacyState = {
      version: 1,
      thread_id: 'thread-legacy',
      envelopes: [
        {
          id: 'msg-legacy',
          sender_agent_id: 'remote@team@peer-instance',
          recipient_agent_id: 'main',
          thread_id: 'thread-legacy',
          intent: 'chat',
          content: 'Legacy persisted message.',
          created_at: '2026-04-28T10:00:00.000Z',
        },
      ],
    };
    const assetPath = store.a2aThreadAssetPath('thread-legacy');
    const legacyContent = JSON.stringify(legacyState);

    revisions.syncRuntimeAssetRevisionState(
      'a2a',
      assetPath,
      {
        actor: 'test',
        route: 'test.a2a.legacy',
        source: 'internal',
      },
      {
        exists: true,
        content: legacyContent,
      },
    );

    expect(store.listA2AThreadEnvelopes('thread-legacy')).toEqual([
      {
        ...legacyState.envelopes[0],
        sender_instance_id: 'peer-instance',
      },
    ]);
    expect(
      revisions.getRuntimeAssetRevisionState('a2a', assetPath)?.content,
    ).toBe(legacyContent);
  });

  test('hydrates sender_instance_id from legacy local persisted envelopes without rewriting state', async () => {
    const store = await import('../src/a2a/store.ts');
    const revisions = await import('../src/config/runtime-config-revisions.ts');
    const legacyState = {
      version: 1,
      thread_id: 'thread-local-legacy',
      envelopes: [
        {
          id: 'msg-local-legacy',
          sender_agent_id: 'main',
          recipient_agent_id: 'writer',
          thread_id: 'thread-local-legacy',
          intent: 'chat',
          content: 'Legacy local persisted message.',
          created_at: '2026-04-28T10:00:00.000Z',
        },
      ],
    };
    const assetPath = store.a2aThreadAssetPath('thread-local-legacy');
    const legacyContent = JSON.stringify(legacyState);

    revisions.syncRuntimeAssetRevisionState(
      'a2a',
      assetPath,
      {
        actor: 'test',
        route: 'test.a2a.legacy-local',
        source: 'internal',
      },
      {
        exists: true,
        content: legacyContent,
      },
    );

    expect(store.listA2AThreadEnvelopes('thread-local-legacy')).toEqual([
      {
        ...legacyState.envelopes[0],
        sender_instance_id: A2A_LOCAL_INSTANCE_ID,
      },
    ]);
    expect(
      revisions.getRuntimeAssetRevisionState('a2a', assetPath)?.content,
    ).toBe(legacyContent);
  });

  test('rejects unknown local agent ids without default-agent fallback', async () => {
    const store = await import('../src/a2a/store.ts');
    const envelopeMod = await import('../src/a2a/envelope.ts');
    const envelope = envelopeMod.validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'researcher',
      recipient_agent_id: 'main',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Can you see this?',
      created_at: '2026-04-28T10:00:00.000Z',
    });

    expect(() => store.saveA2AEnvelope(envelope)).toThrow(
      envelopeMod.A2AEnvelopeValidationError,
    );
    expect(() => store.saveA2AEnvelope(envelope)).toThrow(
      'local agent id researcher does not match a registered agent',
    );
  });

  test('lists persisted threads by latest message recency', async () => {
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const store = await import('../src/a2a/store.ts');
    const envelopeMod = await import('../src/a2a/envelope.ts');

    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [{ id: 'main', owner: 'team' }];
    });

    store.saveA2AEnvelope(
      envelopeMod.validateA2AEnvelope({
        id: 'msg-thread-a-1',
        sender_agent_id: 'main',
        recipient_agent_id: 'main',
        thread_id: 'thread-a',
        intent: 'chat',
        content: 'Older thread.',
        created_at: '2026-04-28T10:00:00.000Z',
      }),
    );
    store.saveA2AEnvelope(
      envelopeMod.validateA2AEnvelope({
        id: 'msg-thread-b-1',
        sender_agent_id: 'main',
        recipient_agent_id: 'main',
        thread_id: 'thread-b',
        intent: 'handoff',
        content: 'Newest thread.',
        created_at: '2026-04-28T10:03:00.000Z',
      }),
    );
    store.saveA2AEnvelope(
      envelopeMod.validateA2AEnvelope({
        id: 'msg-thread-a-2',
        sender_agent_id: 'main',
        recipient_agent_id: 'main',
        thread_id: 'thread-a',
        parent_message_id: 'msg-thread-a-1',
        intent: 'ack',
        content: 'Thread A follow-up.',
        created_at: '2026-04-28T10:02:00.000Z',
      }),
    );

    expect(store.listA2AThreads()).toEqual([
      expect.objectContaining({
        thread_id: 'thread-b',
        message_count: 1,
        latest_message_id: 'msg-thread-b-1',
        latest_intent: 'handoff',
        latest_content: 'Newest thread.',
        latest_created_at: '2026-04-28T10:03:00.000Z',
        latest_sender_agent_id: 'main@team@local-dev',
        latest_recipient_agent_id: 'main@team@local-dev',
        participants: ['main@team@local-dev'],
      }),
      expect.objectContaining({
        thread_id: 'thread-a',
        message_count: 2,
        latest_message_id: 'msg-thread-a-2',
        latest_parent_message_id: 'msg-thread-a-1',
        latest_intent: 'ack',
        latest_content: 'Thread A follow-up.',
        latest_created_at: '2026-04-28T10:02:00.000Z',
        latest_sender_agent_id: 'main@team@local-dev',
        latest_recipient_agent_id: 'main@team@local-dev',
        participants: ['main@team@local-dev'],
      }),
    ]);
  });

  test('rejects duplicate envelope ids in a thread', async () => {
    const store = await import('../src/a2a/store.ts');
    const envelopeMod = await import('../src/a2a/envelope.ts');
    const envelope = envelopeMod.validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'main',
      recipient_agent_id: 'main',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'First copy.',
      created_at: '2026-04-28T10:00:00.000Z',
    });

    store.saveA2AEnvelope(envelope);

    expect(() => store.saveA2AEnvelope(envelope)).toThrow(
      envelopeMod.A2AEnvelopeDuplicateError,
    );
    try {
      store.saveA2AEnvelope(envelope);
    } catch (error) {
      expect(error).toBeInstanceOf(envelopeMod.A2AEnvelopeValidationError);
      expect(error).toBeInstanceOf(envelopeMod.A2AEnvelopeDuplicateError);
      expect((error as A2AEnvelopeDuplicateError).envelopeId).toBe('msg-1');
      expect((error as A2AEnvelopeDuplicateError).threadId).toBe('thread-1');
      return;
    }
    throw new Error('Expected duplicate envelope save to fail.');
  });

  test('allows the same envelope id from different sender instances', async () => {
    const store = await import('../src/a2a/store.ts');
    const envelopeMod = await import('../src/a2a/envelope.ts');

    const first = envelopeMod.validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'agent@team@peer-a',
      recipient_agent_id: 'main',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Peer A copy.',
      created_at: '2026-04-28T10:00:00.000Z',
    });
    const second = envelopeMod.validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'agent@team@peer-b',
      recipient_agent_id: 'main',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Peer B copy.',
      created_at: '2026-04-28T10:01:00.000Z',
    });

    expect(store.saveA2AEnvelope(first)).toMatchObject({
      id: 'msg-1',
      sender_instance_id: 'peer-a',
    });
    expect(store.saveA2AEnvelope(second)).toMatchObject({
      id: 'msg-1',
      sender_instance_id: 'peer-b',
    });
    expect(store.listA2AThreadEnvelopes('thread-1')).toHaveLength(2);
    expect(store.getA2AEnvelope('thread-1', 'msg-1', 'PEER-A')).toMatchObject({
      id: 'msg-1',
      sender_instance_id: 'peer-a',
      content: 'Peer A copy.',
    });
    expect(store.getA2AEnvelope('thread-1', 'msg-1', 'peer-b')).toMatchObject({
      id: 'msg-1',
      sender_instance_id: 'peer-b',
      content: 'Peer B copy.',
    });
    expect(
      store.getA2AEnvelope('thread-1', 'msg-1', 'missing-peer'),
    ).toBeNull();
    expect(() =>
      store.getA2AEnvelope('thread-1', 'msg-1', 'bad instance'),
    ).toThrow('sender_instance_id must be a canonical instance id');
    expect(() => store.getA2AEnvelope('thread-1', 'msg-1')).toThrow(
      'envelope id msg-1 is ambiguous; provide sender_instance_id',
    );
  });
});
