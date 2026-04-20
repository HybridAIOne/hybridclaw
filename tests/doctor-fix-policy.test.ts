import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: ORIGINAL_STDOUT_IS_TTY,
  });
});

test('runDoctor skips approval-required fixes without an interactive terminal', async () => {
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: false,
  });

  const applyMock = vi.fn(async () => {});

  vi.doMock('../src/doctor/checks/index.js', () => ({
    doctorChecks: () => [
      {
        category: 'disk' as const,
        label: 'Risky cleanup',
        run: async () => [
          {
            category: 'disk' as const,
            label: 'Risky cleanup',
            severity: 'error' as const,
            message: 'Approval required before cleanup',
            fix: {
              summary: 'Delete git-backed workspace',
              apply: applyMock,
              requiresApproval: true,
            },
          },
        ],
      },
    ],
  }));

  const { runDoctor } = await import('../src/doctor.ts');
  const report = await runDoctor({
    component: null,
    fix: true,
    json: false,
  });

  expect(applyMock).not.toHaveBeenCalled();
  expect(report.fixes).toEqual([
    expect.objectContaining({
      label: 'Risky cleanup',
      status: 'skipped',
      message: 'Skipped because interactive approval is required',
    }),
  ]);
});
