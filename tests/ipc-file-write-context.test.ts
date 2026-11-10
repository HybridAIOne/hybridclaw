import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { encodeFileWriteGuardContext } from '@hybridclaw/shared/file-write-guard';
import { ipcOutputFileName } from '@hybridclaw/shared/ipc-output-files';
import { beginFileWriteReviewContext } from '../src/infra/file-write-review-context.js';
import { isContainerOutput } from '../src/infra/ipc-output-validation.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir();
useCleanMocks({ resetModules: true, unstubAllEnvs: true });
const valid = { status: 'success', result: 'Queued fixture.', toolsUsed: [] };

test.each(
  [
    'fileWriteGuardSessionId',
    'fileWriteGuardUserPrompt',
    'fileWriteGuardProof',
  ].flatMap((field) =>
    [null, false, 42, [], {}].map((value) => ({ field, value })),
  ),
)('rejects malformed preservation field $field: $value', ({ field, value }) => {
  expect(isContainerOutput({ ...valid, [field]: value })).toBe(false);
});

test.each(['valid', 'forged', 'stale'])(
  '%s receipt crosses IPC but still requires authentication',
  async (kind) => {
    const secret = 'test-key';
    const request = {
      sessionId: 'test-worker',
      requestId: 'request-a',
      fileWriteGuardSessionId: 'root-worker',
    };
    const prompt = 'Preserve the existing notes.';
    const proof =
      kind === 'forged'
        ? 'forged'
        : encodeFileWriteGuardContext(
            secret,
            {
              ...request,
              requestId:
                kind === 'stale' ? 'previous-request' : request.requestId,
            },
            prompt,
          );
    const frame = {
      ...valid,
      fileWriteGuardSessionId: 'untrusted-worker',
      fileWriteGuardUserPrompt: 'Untrusted replacement instruction.',
      fileWriteGuardProof: proof,
      sideEffects: {
        delegations: [{ action: 'delegate', prompt: 'Prepare a summary.' }],
      },
    };
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp());
    mockIpcWatcher();
    const ipc = await import('../src/infra/ipc.js');
    ipc.ensureSessionDirs(request.sessionId);
    const file = path.join(
      ipc.getSessionPaths(request.sessionId, 'main').ipcPath,
      ipcOutputFileName(request.requestId),
    );
    fs.writeFileSync(file, JSON.stringify(frame));
    const output = await ipc.readOutput(
      request.sessionId,
      request.requestId,
      100,
    );
    expect(output).toEqual(frame);
    expect(fs.existsSync(file)).toBe(false);
    if (!output) throw new Error('Worker reply was not read.');
    const active = beginFileWriteReviewContext(request, secret);
    try {
      const finished = active.finish(output);
      expect(finished.fileWriteGuardProof).toBeUndefined();
      if (kind === 'valid') {
        expect(finished).toMatchObject({
          status: 'success',
          fileWriteGuardSessionId: request.fileWriteGuardSessionId,
          fileWriteGuardUserPrompt: prompt,
          sideEffects: frame.sideEffects,
        });
      } else {
        expect(finished.status).toBe('error');
        expect(finished.sideEffects?.delegations).toBeUndefined();
        expect(finished.fileWriteGuardSessionId).toBeUndefined();
        expect(finished.fileWriteGuardUserPrompt).toBeUndefined();
      }
    } finally {
      active.close();
    }
  },
);
