import { afterEach, expect, test, vi } from 'vitest';

const { infoMock, recordAuditEventMock, safeApplyMock, riskyApplyMock } =
  vi.hoisted(() => ({
    infoMock: vi.fn(),
    recordAuditEventMock: vi.fn(),
    safeApplyMock: vi.fn(async () => {}),
    riskyApplyMock: vi.fn(async () => {}),
  }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  infoMock.mockReset();
  recordAuditEventMock.mockReset();
  safeApplyMock.mockReset();
  riskyApplyMock.mockReset();
});

test('resource hygiene maintenance auto-applies only safe warn fixes', async () => {
  vi.doMock('../src/doctor/checks/resource-hygiene.js', () => ({
    resourceHygieneDoctorChecks: () => [
      {
        category: 'disk' as const,
        label: 'Old temp media',
        run: async () => [
          {
            category: 'disk' as const,
            label: 'Old temp media',
            severity: 'warn' as const,
            message: 'Safe cleanup is available',
            fix: {
              summary: 'Delete old temp media',
              apply: safeApplyMock,
            },
          },
        ],
      },
      {
        category: 'disk' as const,
        label: 'Git-backed stale workspaces',
        run: async () => [
          {
            category: 'disk' as const,
            label: 'Git-backed stale workspaces',
            severity: 'error' as const,
            message: 'Approval required before cleanup',
            fix: {
              summary: 'Delete git-backed workspace',
              apply: riskyApplyMock,
              requiresApproval: true,
            },
          },
        ],
      },
    ],
  }));
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId: () => 'maintenance-run',
    recordAuditEvent: recordAuditEventMock,
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      info: infoMock,
    },
  }));

  const { runResourceHygieneMaintenance } = await import(
    '../src/doctor/resource-hygiene.ts'
  );

  const report = await runResourceHygieneMaintenance();

  expect(safeApplyMock).toHaveBeenCalledTimes(1);
  expect(riskyApplyMock).not.toHaveBeenCalled();
  expect(report.fixes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: 'Old temp media',
        status: 'applied',
      }),
      expect.objectContaining({
        label: 'Git-backed stale workspaces',
        status: 'skipped',
        message: 'Skipped because manual approval is required',
      }),
    ]),
  );
  expect(
    recordAuditEventMock.mock.calls.some(
      ([payload]) =>
        payload.event?.type === 'approval.request' &&
        payload.event?.action === 'maintenance:resource-hygiene',
    ),
  ).toBe(true);
  expect(infoMock).toHaveBeenCalledWith(
    expect.objectContaining({
      trigger: 'scheduler',
      approvalRequired: ['Git-backed stale workspaces'],
    }),
    'Resource hygiene maintenance completed',
  );
});
