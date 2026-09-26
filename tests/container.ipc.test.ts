import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ContainerOutput } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-container-ipc-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
});

test.each([
  ['writeOutput', 'output.json'],
  ['writeHealthOutput', 'health-output.json'],
] as const)(
  '%s never shows a poller a half-written %s',
  async (writer, name) => {
    const ipcDir = makeTempDir();
    vi.stubEnv('HYBRIDCLAW_AGENT_IPC_DIR', ipcDir);
    const ipc = await import('../container/src/ipc.js');
    const target = path.join(ipcDir, name);
    const writeFileSync = fs.writeFileSync;
    const polled: Array<string | null> = [];
    // writeFileSync creates its file before the contents land. Hold each write
    // in that state and record what a poller of the target reads meanwhile.
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      writeFileSync(file, '', options);
      polled.push(
        fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null,
      );
      writeFileSync(file, data, { flag: 'w' });
    });
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
    };

    ipc[writer](output);

    expect(polled).toEqual([null]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(output);
    expect(fs.readdirSync(ipcDir)).toEqual([name]);
  },
);
