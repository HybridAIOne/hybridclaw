import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export function setupA2AWebhookTestEnv(tempHomePrefix: string): void {
  const originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  const originalHome = process.env.HOME;
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tempHomePrefix));
    process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
    process.env.HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnvVar('HYBRIDCLAW_DATA_DIR', originalDataDir);
    restoreEnvVar('HOME', originalHome);
    vi.resetModules();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });
}

export function sampleA2AWebhookEnvelope(id: string) {
  return {
    id,
    sender_agent_id: 'main',
    recipient_agent_id: 'remote@team@peer-instance',
    thread_id: 'thread-webhook',
    intent: 'chat',
    content: `Webhook payload ${id}`,
    created_at: '2026-05-01T10:00:00.000Z',
  };
}
