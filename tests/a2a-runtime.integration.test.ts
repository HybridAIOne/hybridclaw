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
        { id: 'stub-a', owner: 'team', role: 'sender', reportsTo: 'main' },
        {
          id: 'stub-b',
          owner: 'team',
          role: 'recipient',
          reportsTo: 'main',
          peers: ['stub-a'],
        },
      ];
    });

    const confirmation = runtime.sendMessage(
      {
        id: 'msg-1',
        sender_agent_id: 'stub-a',
        recipient_agent_id: 'stub-b',
        thread_id: 'thread-1',
        intent: 'handoff',
        content: 'Please take over the customer brief.',
        created_at: '2026-04-29T10:00:00.000Z',
      },
      {
        actor: 'stub-a',
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
    expect(handoff?.content).toContain('sender_manager: main (lead)');
    expect(handoff?.content).toContain('recipient_manager: main (lead)');
    expect(handoff?.content).toContain('recipient_peers: stub-a (sender)');
    expect(handoff?.content).toContain(
      'recipient_escalation_chain: main (lead)',
    );
  });
});
