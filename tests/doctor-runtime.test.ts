import { expect, test, vi } from 'vitest';
import { checkRuntime } from '../src/doctor/checks/runtime.ts';
import { useCleanMocks } from './test-utils.ts';

vi.mock('../src/doctor/utils.js', () => ({
  runVersionCommand: vi.fn(() => '11.10.0'),
  makeResult: (
    id: string,
    label: string,
    severity: string,
    message: string,
  ) => ({ id, label, severity, message }),
}));
useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

test.each([
  ['22.23.3', 'error'],
  ['22.22.99', 'error'],
  ['22.23.4', 'ok'],
  ['22.24.0', 'ok'],
  ['23.0.0', 'error'],
  ['24.0.0', 'error'],
])('doctor reports %s as %s', async (version, severity) => {
  vi.stubGlobal('process', {
    ...process,
    versions: { ...process.versions, node: version },
  });
  expect(await checkRuntime()).toMatchObject([{ severity }]);
});
