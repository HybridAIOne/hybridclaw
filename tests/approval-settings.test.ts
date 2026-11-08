import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { APPROVAL_MODES, normalizeApprovalMode } from '../container/shared/approval-mode.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('approval-settings-');
useCleanMocks({ cleanup: cleanupGatewayRuntime, resetModules: true, unstubAllEnvs: true });

test.each([null, '', 'unknown', {}, false])('invalid defaults fail closed: %j', (value) => {
  expect(() => normalizeApprovalMode(value)).toThrow();
});

test('new conversations inherit the saved default, while existing sessions, forks and ordinary resets preserve their choice', async () => {
  const root = temp();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ops: { dbPath: path.join(root, 'test.db') } }));
  const config = await import('../src/config/runtime-config.js');
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const original = db.getOrCreateSession('original', null, 'web-original');
  expect(original.approval_mode).toBe('auto');
  for (const mode of APPROVAL_MODES) {
    const next = structuredClone(config.getRuntimeConfig());
    next.security.defaultApprovalMode = mode;
    config.saveRuntimeConfig(next);
    expect(db.getOrCreateSession(`new-${mode}`, null, `web-${mode}`).approval_mode).toBe(mode);
    expect(db.getOrCreateSession(original.id, null, 'web-original').approval_mode).toBe('auto');
  }
  const messageId = db.storeMessage(original.id, 'user_a', 'Example', 'user', 'Synthetic message');
  expect(db.forkSessionBranch({ sessionId: original.id, beforeMessageId: messageId }).session.approval_mode).toBe('auto');
  const rotated = db.createFreshSessionInstance(original.id).session;
  expect(rotated.approval_mode).toBe('auto');
  expect(db.createFreshSessionInstance(rotated.id, { resetSettings: true }).session.approval_mode).toBe('learning');
  const invalid = structuredClone(config.getRuntimeConfig());
  Object.assign(invalid.security, { defaultApprovalMode: 'invalid' });
  expect(() => config.saveRuntimeConfig(invalid)).toThrow();
  expect(config.getRuntimeConfig().security.defaultApprovalMode).toBe('learning');
});
