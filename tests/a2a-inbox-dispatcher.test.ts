import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;
const LOCAL_MAIN_AGENT_ID = 'main@team@local-dev';

let tmpDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-inbox-dispatch-'));
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

async function loadDispatchModules() {
  const [db, runtimeConfig, runtime, dispatchStore, dispatcher] =
    await Promise.all([
      import('../src/memory/db.ts'),
      import('../src/config/runtime-config.ts'),
      import('../src/a2a/runtime.ts'),
      import('../src/a2a/a2a-inbox-dispatch-store.ts'),
      import('../src/a2a/a2a-inbox-dispatcher.ts'),
    ]);

  db.initDatabase({ quiet: true });
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', owner: 'team', role: 'lead' },
      { id: 'writer', owner: 'team', role: 'writer' },
    ];
  });

  return { runtime, dispatchStore, dispatcher };
}

function a2aEnvelope(
  id: string,
  overrides: Partial<{
    sender_agent_id: string;
    recipient_agent_id: string;
    thread_id: string;
    intent: 'chat' | 'handoff' | 'escalate' | 'ack' | 'policy.update';
    content: string;
    created_at: string;
  }> = {},
) {
  return {
    id,
    sender_agent_id: overrides.sender_agent_id ?? 'remote@team@peer-instance',
    recipient_agent_id: overrides.recipient_agent_id ?? LOCAL_MAIN_AGENT_ID,
    thread_id: overrides.thread_id ?? 'thread-a2a-dispatch',
    intent: overrides.intent ?? ('chat' as const),
    content: overrides.content ?? `Dispatch payload ${id}`,
    created_at: overrides.created_at ?? '2026-05-01T10:00:00.000Z',
  };
}

describe('A2A inbox dispatch processor', () => {
  test('dispatches delivered A2A envelopes to the addressed local agent', async () => {
    const { runtime, dispatchStore, dispatcher } = await loadDispatchModules();
    runtime.sendMessage(
      a2aEnvelope('msg-dispatch-1', { recipient_agent_id: 'main' }),
      {
        actor: 'remote@team@peer-instance',
        sessionId: 'a2a:inbound:peer',
        auditRunId: 'run-a2a-inbound',
        auditRole: 'receiver',
      },
    );

    expect(
      dispatchStore.listA2AInboxDispatchItems({ status: 'pending' }),
    ).toHaveLength(1);

    const dispatch = vi.fn(async () => ({ status: 'success' as const }));
    await expect(
      dispatcher.processA2AInboxDispatchQueue({ dispatch }),
    ).resolves.toMatchObject({
      processed: 1,
      dispatched: 1,
      failed: 0,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'main',
      channelId: 'a2a',
      userId: 'remote@team@peer-instance',
      source: 'a2a.dispatch',
      addressEnvelope: {
        to: 'main',
        from: 'remote@team@peer-instance',
      },
    });
    expect(dispatch.mock.calls[0]?.[0].content).toContain(
      'Dispatch payload msg-dispatch-1',
    );
    expect(dispatch.mock.calls[0]?.[0].content).toContain(
      'Intent: chat',
    );
    expect(
      dispatchStore.listA2AInboxDispatchItems({ status: 'succeeded' }),
    ).toHaveLength(1);
  });

  test('does not redispatch an already processed envelope', async () => {
    const { dispatchStore, dispatcher } = await loadDispatchModules();
    const envelope = a2aEnvelope('msg-dispatch-idempotent');

    const first = dispatchStore.enqueueA2AInboxDispatch(envelope);
    const second = dispatchStore.enqueueA2AInboxDispatch(envelope);
    expect(second.id).toBe(first.id);

    const dispatch = vi.fn(async () => ({ status: 'success' as const }));
    await dispatcher.processA2AInboxDispatchQueue({ dispatch });
    await dispatcher.processA2AInboxDispatchQueue({ dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      dispatchStore.listA2AInboxDispatchItems({ status: 'succeeded' }),
    ).toHaveLength(1);
  });

  test('fails closed when the recipient does not resolve to a local agent', async () => {
    const { dispatchStore, dispatcher } = await loadDispatchModules();
    dispatchStore.enqueueA2AInboxDispatch(
      a2aEnvelope('msg-dispatch-unknown', {
        recipient_agent_id: 'unknown@team@local-dev',
      }),
    );

    const dispatch = vi.fn(async () => ({ status: 'success' as const }));
    await expect(
      dispatcher.processA2AInboxDispatchQueue({ dispatch }),
    ).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });

    expect(dispatch).not.toHaveBeenCalled();
    const [failed] = dispatchStore.listA2AInboxDispatchItems({
      status: 'failed',
    });
    expect(failed?.lastError).toContain(
      'recipient_agent_id does not resolve to a local agent',
    );
  });

  test('retries failed recipient runs and then marks exhausted dispatches failed', async () => {
    const { dispatchStore, dispatcher } = await loadDispatchModules();
    dispatchStore.enqueueA2AInboxDispatch(a2aEnvelope('msg-dispatch-fails'), {
      maxAttempts: 1,
    });

    const dispatch = vi.fn(async () => ({
      status: 'error' as const,
      error: 'recipient runtime crashed',
    }));
    await expect(
      dispatcher.processA2AInboxDispatchQueue({ dispatch }),
    ).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [failed] = dispatchStore.listA2AInboxDispatchItems({
      status: 'failed',
    });
    expect(failed).toMatchObject({
      attempts: 1,
      lastError: 'recipient runtime crashed',
    });
  });

  test('stores ack envelopes without auto-dispatching them', async () => {
    const { dispatchStore, dispatcher } = await loadDispatchModules();
    dispatchStore.enqueueA2AInboxDispatch(
      a2aEnvelope('msg-dispatch-ack', { intent: 'ack' }),
    );

    const dispatch = vi.fn(async () => ({ status: 'success' as const }));
    await expect(
      dispatcher.processA2AInboxDispatchQueue({ dispatch }),
    ).resolves.toMatchObject({
      processed: 1,
      ignored: 1,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(
      dispatchStore.listA2AInboxDispatchItems({ status: 'ignored' }),
    ).toHaveLength(1);
  });

  test('suppresses dispatch when the thread loop budget is exhausted', async () => {
    const { dispatchStore, dispatcher } = await loadDispatchModules();
    dispatchStore.enqueueA2AInboxDispatch(
      a2aEnvelope('msg-dispatch-loop', { thread_id: 'thread-loop' }),
    );

    const dispatch = vi.fn(async () => ({ status: 'success' as const }));
    await expect(
      dispatcher.processA2AInboxDispatchQueue({
        dispatch,
        loopMaxPerThread: 0,
      }),
    ).resolves.toMatchObject({
      processed: 1,
      suppressed: 1,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(
      dispatchStore.listA2AInboxDispatchItems({ status: 'suppressed' }),
    ).toHaveLength(1);
  });
});
