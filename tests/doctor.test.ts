import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function createTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-doctor-'));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctor fixes insecure credentials permissions and reruns the check', async () => {
  const homeDir = createTempHome();
  process.env.HOME = homeDir;

  const credentialsPath = path.join(homeDir, '.hybridclaw', 'credentials.json');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(
    credentialsPath,
    `${JSON.stringify({ HYBRIDAI_API_KEY: 'hai-test-1234567890' }, null, 2)}\n`,
    'utf-8',
  );
  fs.chmodSync(credentialsPath, 0o644);

  const { runDoctor } = await import('../src/doctor.ts');
  const report = await runDoctor({
    component: 'credentials',
    fix: true,
    json: false,
  });

  expect(report.summary).toMatchObject({
    ok: 1,
    warn: 0,
    error: 0,
    exitCode: 0,
  });
  expect(report.fixes).toEqual([
    expect.objectContaining({
      label: 'Credentials',
      status: 'applied',
    }),
  ]);
  expect(report.results).toEqual([
    expect.objectContaining({
      label: 'Credentials',
      severity: 'ok',
      fixable: false,
    }),
  ]);
  expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
});

test('renderDoctorReport prints the summary and applied fixes', async () => {
  const { renderDoctorReport } = await import('../src/doctor.ts');
  const output = renderDoctorReport({
    generatedAt: '2026-03-17T10:00:00.000Z',
    component: null,
    results: [
      {
        category: 'gateway',
        label: 'Gateway',
        severity: 'ok',
        message: 'PID 12345, uptime 2h 34m, 3 sessions',
        fixable: false,
      },
      {
        category: 'docker',
        label: 'Docker',
        severity: 'warn',
        message:
          'Image hybridclaw-agent not found locally; run: npm run build:container',
        fixable: true,
      },
    ],
    summary: {
      ok: 1,
      warn: 1,
      error: 0,
      exitCode: 0,
    },
    fixes: [
      {
        category: 'docker',
        label: 'Docker',
        status: 'applied',
        message: 'Applied fix for docker',
      },
    ],
  });

  expect(output).toContain('HybridClaw Doctor');
  expect(output).toContain('✓ Gateway');
  expect(output).toContain('⚠ Docker');
  expect(output).toContain('✓ Fix Docker');
  expect(output).toContain('1 ok · 1 warning · 0 errors');
});
