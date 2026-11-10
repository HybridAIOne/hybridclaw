import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { ipcOutputFileName } from '@hybridclaw/shared/ipc-output-files';
import { isContainerOutput } from '../src/infra/ipc-output-validation.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
useCleanMocks({ resetModules: true, unstubAllEnvs: true });
const valid = { status: 'success', result: 'ok', toolsUsed: [] };
const execution = {
  name: 'bash',
  arguments: '{"command":"ls"}',
  result: 'README.md',
  durationMs: 12,
};
test.each([
  null,
  [],
  {},
  { ...valid, status: 'unknown' },
  { ...valid, result: 42 },
  { ...valid, toolsUsed: 'bash' },
  { ...valid, toolsUsed: [42] },
  { ...valid, artifacts: [null] },
  { ...valid, toolExecutions: [{}] },
  { ...valid, sideEffects: 'wrong-shape' },
  { ...valid, sideEffects: { delegations: [{}] } },
  { ...valid, pendingApproval: { approvalId: 'a' } },
  { ...valid, tokenUsage: {} },
  { ...valid, toolHistory: [42] },
  { ...valid, toolExecutions: [{ ...execution, approvalTier: 'purple' }] },
  {
    ...valid,
    toolExecutions: [
      { ...execution, anomaly: { score: 1, status: 'unknown' } },
    ],
  },
  { ...valid, recovery: { kind: 'recovered' } },
  { ...valid, errorCode: 'crashed' },
  {
    ...valid,
    outputPresentation: {
      segmentKind: ['final'],
      visible: true,
      displaySurface: 'assistant_bubble',
    },
  },
])('rejects malformed worker reply %j', (value) => {
  expect(isContainerOutput(value)).toBe(false);
});
test('accepts ordinary success, error, and delegation replies', () => {
  expect(isContainerOutput(valid)).toBe(true);
  expect(
    isContainerOutput({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'Stopped',
    }),
  ).toBe(true);
  expect(
    isContainerOutput({
      ...valid,
      sideEffects: {
        delegations: [
          { action: 'delegate', mode: 'single', prompt: 'Prepare a report' },
        ],
      },
    }),
  ).toBe(true);
});
test('accepts a reply carrying every contract part', () => {
  expect(
    isContainerOutput({
      ...valid,
      toolExecutions: [
        {
          ...execution,
          approvalTier: 'yellow',
          approvalDecision: 'approved_session',
          escalationTarget: { channel: 'slack', recipient: 'user_a' },
          anomaly: {
            score: 0.2,
            threshold: null,
            reason: 'typical',
            status: 'scored',
            model: 'test-model',
            trajectoryCount: 3,
            tuple: 'bash:ls',
          },
        },
      ],
      recovery: {
        kind: 'recovered',
        turnId: 'turn-a',
        calls: [
          { messageIndex: 1, toolCallId: 'call-a', outcome: 'not_executed' },
        ],
      },
      approvalReply: { decision: 'approve', approvalId: 'a', scope: 'once' },
      memoryCitations: [
        { ref: '[mem:1]', memoryId: 1, content: 'note', confidence: 0.9 },
      ],
      fileWriteGuardSessionId: 'session-a',
    }),
  ).toBe(true);
});
test('a malformed reply becomes an error without retaining worker side effects', async () => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp());
  mockIpcWatcher();
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('test-session');
  const file = path.join(
    ipc.getSessionPaths('test-session', 'main').ipcPath,
    ipcOutputFileName('request-a'),
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...valid,
      result: 42,
      sideEffects: {
        delegations: [{ action: 'delegate', prompt: 'Prepare a report' }],
      },
    }),
  );
  const output = await ipc.readOutput('test-session', 'request-a', 100);
  expect(output).toMatchObject({ status: 'error', toolsUsed: [] });
  expect(output?.sideEffects).toBeUndefined();
  expect(fs.existsSync(file)).toBe(false);
});

test.each([
  'fileWriteGuardSessionId',
  'fileWriteGuardUserPrompt',
  'fileWriteGuardProof',
])('validates the transported %s field', (field) => {
  expect(isContainerOutput({ ...valid, [field]: 'test-value' })).toBe(true);
  expect(isContainerOutput({ ...valid, [field]: 42 })).toBe(false);
});
