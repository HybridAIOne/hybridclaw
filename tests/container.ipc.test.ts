import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { encodeAuthenticatedInput } from '../container/shared/ipc-input-auth.js';
import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';
import type { ContainerOutput } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const WORKER_SECRET = 'worker-secret';

const makeTempDir = useTempDir('hybridclaw-container-ipc-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
});

test.each([
  ['writeOutput', ipcOutputFileName('request-1')],
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

    if (writer === 'writeOutput') ipc.writeOutput(output, 'request-1');
    else ipc.writeHealthOutput(output);

    expect(polled).toEqual([null]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(output);
    expect(fs.readdirSync(ipcDir)).toEqual([name]);
  },
);

test.each([
  {
    name: 'input.json',
    write: (ipcDir: string) =>
      fs.writeFileSync(
        path.join(ipcDir, 'input.json'),
        encodeAuthenticatedInput(
          WORKER_SECRET,
          JSON.stringify({ sessionId: 'session-a', messages: [] }),
        ),
      ),
    expected: { sessionId: 'session-a' },
  },
  {
    name: 'health-input.json',
    write: (ipcDir: string) =>
      fs.writeFileSync(
        path.join(ipcDir, 'health-input.json'),
        JSON.stringify({ healthCheck: { nonce: 'n1' } }),
      ),
    expected: { healthCheck: { nonce: 'n1' } },
  },
])(
  'once shutdown starts, waitForInput leaves $name for the replacement agent',
  async ({ name, write, expected }) => {
    const ipcDir = makeTempDir();
    vi.stubEnv('HYBRIDCLAW_AGENT_IPC_DIR', ipcDir);
    const { waitForInput, setIpcAuthSecret } = await import(
      '../container/src/ipc.js'
    );
    const { startShutdown } = await import('../container/src/shutdown-latch.js');
    setIpcAuthSecret(WORKER_SECRET);
    write(ipcDir);
    await expect(waitForInput(1_000)).resolves.toMatchObject(expected);

    const waiting = waitForInput(5_000);
    void startShutdown(() => new Promise<never>(() => {}));
    write(ipcDir);

    await expect(waiting).resolves.toBeNull();
    expect(fs.readdirSync(ipcDir)).toEqual([name]);
  },
);
