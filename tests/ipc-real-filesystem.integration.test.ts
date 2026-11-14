import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ipcOutputFileName } from '@hybridclaw/shared/ipc-output-files';
import type { ContainerOutput } from '../src/types/container.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hybridclaw-ipc-filesystem-');
let pending: Promise<ContainerOutput> | undefined;
const controller = new AbortController();
useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  resetModules: true,
  cleanup: async () => {
    controller.abort();
    await pending;
    await cleanupGatewayRuntime();
  },
});

it('consumes a real atomic reply rename through notification or reconciliation', async () => {
  const home = temp();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('example-session');
  const directory = ipc.getSessionPaths('example-session', 'main').ipcPath;
  const target = path.join(directory, ipcOutputFileName('example-request'));
  const temporary = path.join(directory, 'reply.tmp');
  pending = ipc.readOutput('example-session', 'example-request', 10_000, {
    signal: controller.signal,
  });
  const reply = { status: 'success', result: 'example result', toolsUsed: [] };
  fs.writeFileSync(temporary, JSON.stringify(reply));
  fs.renameSync(temporary, target);
  await expect(pending).resolves.toEqual(reply);
  expect(fs.existsSync(target)).toBe(false);
});
