import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type A2AEnvelopeDuplicateError,
  A2AEnvelopeValidationError,
  classifyA2AAgentId,
  createA2AEnvelope,
  validateA2AEnvelope,
} from '../src/a2a/envelope.ts';

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

  test('rejects malformed envelopes', () => {
    expect(() =>
      validateA2AEnvelope({
        id: 'bad id',
        sender_agent_id: 'agent@too@many@segments',
        recipient_agent_id: 'writer one',
        thread_id: 'thread-1',
        intent: 'notify',
        content: ['not', 'text'],
        created_at: 'not-a-date',
        extra: true,
      }),
    ).toThrow(A2AEnvelopeValidationError);

    try {
      validateA2AEnvelope({
        id: 'bad id',
        sender_agent_id: 'agent@too@many@segments',
        recipient_agent_id: 'writer one',
        thread_id: 'thread-1',
        intent: 'notify',
        content: ['not', 'text'],
        created_at: 'not-a-date',
        extra: true,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(A2AEnvelopeValidationError);
      expect((error as A2AEnvelopeValidationError).issues).toEqual(
        expect.arrayContaining([
          'unexpected field: extra',
          'id must be a non-empty id without whitespace',
          'sender_agent_id must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
          'recipient_agent_id must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
          'intent must be one of: chat, handoff, escalate, ack',
          'content must be a string',
          'created_at must be an ISO timestamp',
        ]),
      );
      return;
    }

    throw new Error('Expected validation to fail.');
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
    };
    const resolvedSecond = {
      ...second,
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
});
