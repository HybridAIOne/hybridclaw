import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { encodeAuthenticatedInput } from '#shared/ipc-input-auth.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-ipc-replay-');
useCleanMocks({ restoreAllMocks: true, resetModules: true, unstubAllEnvs: true });
const secret = 'test-key';
let inputPath: string;
let ipc: typeof import('../container/src/ipc.js');

beforeEach(async () => {
  const dir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_IPC_DIR', dir);
  mockIpcWatcher();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ipc = await import('../container/src/ipc.js');
  ipc.setIpcAuthSecret(secret);
  inputPath = path.join(dir, 'input.json');
});

function envelope(requestId: string, signingSecret = secret): string {
  return encodeAuthenticatedInput(
    signingSecret,
    JSON.stringify({ sessionId: 'session-a', requestId, messages: [] }),
  );
}

async function consume(raw: string) {
  fs.writeFileSync(inputPath, raw);
  return ipc.waitForInput(20);
}

test.each(['immediate', 'older', 'reformatted', 'same secret'])(
  'drops a consumed envelope on %s replay',
  async (replay) => {
    const raw = envelope('request-1');
    await expect(consume(raw)).resolves.toMatchObject({ requestId: 'request-1' });
    if (replay === 'older') {
      await expect(consume(envelope('request-2'))).resolves.toMatchObject({
        requestId: 'request-2',
      });
    }
    if (replay === 'same secret') ipc.setIpcAuthSecret(secret);
    await expect(
      consume(replay === 'reformatted' ? JSON.stringify(JSON.parse(raw), null, 2) : raw),
    ).resolves.toBeNull();
    expect(fs.existsSync(inputPath)).toBe(false);
    await expect(consume(envelope('request-3'))).resolves.toMatchObject({
      requestId: 'request-3',
    });
  },
);

test('a rejected signature does not consume a request', async () => {
  await expect(consume(envelope('request-1', 'wrong-key'))).resolves.toBeNull();
  await expect(consume(envelope('request-1'))).resolves.toMatchObject({
    requestId: 'request-1',
  });
});

test('a new worker secret rejects old envelopes and accepts freshly signed input', async () => {
  await consume(envelope('request-1'));
  ipc.setIpcAuthSecret('replacement-key');
  await expect(consume(envelope('request-1'))).resolves.toBeNull();
  await expect(consume(envelope('request-1', 'replacement-key'))).resolves.toMatchObject({
    requestId: 'request-1',
  });
});
