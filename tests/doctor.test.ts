import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  vi.doUnmock('node:child_process');
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctor fixes insecure credentials permissions and reruns the check', async () => {
  const homeDir = createTempDir('hybridclaw-doctor-home-');
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

test('checkProviders treats probe failures as provider health failures', async () => {
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      hybridai: {
        defaultModel: 'gpt-5-nano',
        models: ['gpt-5'],
      },
      codex: {
        models: [],
      },
      openrouter: {
        enabled: false,
        models: [],
      },
    }),
  }));
  vi.doMock('../src/providers/factory.js', () => ({
    resolveModelProvider: () => 'hybridai',
  }));
  vi.doMock('../src/auth/codex-auth.js', () => ({
    getCodexAuthStatus: () => ({
      authenticated: false,
      reloginRequired: true,
    }),
  }));
  vi.doMock('../src/doctor/provider-probes.js', () => ({
    probeHybridAI: vi.fn(async () => {
      throw new Error('network down');
    }),
    probeCodex: vi.fn(),
    probeOpenRouter: vi.fn(),
  }));

  const { checkProviders } = await import('../src/doctor/checks/providers.ts');
  const [result] = await checkProviders();

  expect(result.severity).toBe('error');
  expect(result.message).toContain('HybridAI network down');
});

test('checkDatabase reports a stale schema as warn with a migration fix', async () => {
  const dir = createTempDir('hybridclaw-doctor-db-');
  const dbPath = path.join(dir, 'hybridclaw.db');
  const database = new Database(dbPath);
  database.pragma('user_version = 11');
  database.close();

  const initDatabase = vi.fn();
  vi.doMock('../src/config/config.js', () => ({
    DB_PATH: dbPath,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    DATABASE_SCHEMA_VERSION: 12,
    initDatabase,
  }));

  const { checkDatabase } = await import('../src/doctor/checks/database.ts');
  const [result] = await checkDatabase();

  expect(result.severity).toBe('warn');
  expect(result.message).toContain('migration available to v12');
  expect(result.fix).toBeDefined();

  await result.fix?.apply();
  expect(initDatabase).toHaveBeenCalledWith({ quiet: true, dbPath });
});

test('checkDatabase reports an unwritable database as error', async () => {
  const dir = createTempDir('hybridclaw-doctor-db-');
  const dbPath = path.join(dir, 'hybridclaw.db');
  const database = new Database(dbPath);
  database.pragma('user_version = 12');
  database.close();
  fs.chmodSync(dbPath, 0o444);

  vi.doMock('../src/config/config.js', () => ({
    DB_PATH: dbPath,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    DATABASE_SCHEMA_VERSION: 12,
    initDatabase: vi.fn(),
  }));

  const { checkDatabase } = await import('../src/doctor/checks/database.ts');
  const [result] = await checkDatabase();

  expect(result.severity).toBe('error');
  expect(result.message).toContain('file is not writable');
  expect(result.fix).toBeUndefined();
});

test('checkGateway exposes a restart fix when the PID is alive but the API is unreachable', async () => {
  const restartGatewayFromDoctor = vi.fn(async () => {});

  vi.doMock('../src/gateway/gateway-client.js', () => ({
    gatewayHealth: vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }),
  }));
  vi.doMock('../src/gateway/gateway-lifecycle.js', () => ({
    readGatewayPid: () => ({
      pid: 12345,
      startedAt: '2026-03-17T10:00:00.000Z',
      cwd: '/tmp/hybridclaw-doctor',
      command: ['node', 'dist/cli.js', 'gateway'],
    }),
    isPidRunning: () => true,
    removeGatewayPidFile: vi.fn(),
  }));
  vi.doMock('../src/doctor/gateway-repair.js', () => ({
    restartGatewayFromDoctor,
  }));

  const { checkGateway } = await import('../src/doctor/checks/gateway.ts');
  const [result] = await checkGateway();

  expect(result.severity).toBe('error');
  expect(result.fix?.summary).toContain('restart');

  await result.fix?.apply();
  expect(restartGatewayFromDoctor).toHaveBeenCalledTimes(1);
});

test('checkDocker only reports daemon and image state', async () => {
  vi.doMock('node:child_process', () => ({
    spawnSync: vi.fn(() => ({
      status: 0,
      error: null,
      stderr: '',
      stdout: '',
    })),
  }));
  vi.doMock('../src/config/config.js', () => ({
    CONTAINER_IMAGE: 'hybridclaw-agent',
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      container: {
        sandboxMode: 'container',
      },
    }),
  }));
  vi.doMock('../src/infra/container-setup.js', () => ({
    containerImageExists: vi.fn(async () => true),
    ensureContainerImageReady: vi.fn(),
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallRoot: () => '/tmp/hybridclaw-doctor',
  }));

  const { checkDocker } = await import('../src/doctor/checks/docker.ts');
  const [result] = await checkDocker();

  expect(result.severity).toBe('ok');
  expect(result.message).toBe('Daemon running, image hybridclaw-agent present');
  expect(result.message).not.toContain('free');
});

test('checkSecurity does not offer an auto-fix for modified instruction copies', async () => {
  const dataDir = createTempDir('hybridclaw-doctor-security-');

  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: dataDir,
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({}),
    isSecurityTrustAccepted: () => true,
  }));
  vi.doMock('../src/security/instruction-integrity.js', () => ({
    summarizeInstructionIntegrity: () => 'SECURITY.md:modified',
    syncRuntimeInstructionCopies: vi.fn(),
    verifyInstructionIntegrity: () => ({
      ok: false,
      files: [
        {
          path: 'SECURITY.md',
          sourcePath: '/repo/SECURITY.md',
          runtimePath: '/tmp/runtime/SECURITY.md',
          expectedHash: 'expected',
          actualHash: 'actual',
          status: 'modified',
        },
      ],
    }),
  }));

  const { checkSecurity } = await import('../src/doctor/checks/security.ts');
  const [result] = await checkSecurity();

  expect(result.severity).toBe('warn');
  expect(result.message).toContain('SECURITY.md:modified');
  expect(result.fix).toBeUndefined();
});

test('checkChannels distinguishes intentionally disabled channels from missing setup', async () => {
  vi.doMock('../src/config/config.js', () => ({
    DISCORD_TOKEN: '',
    EMAIL_PASSWORD: '',
    MSTEAMS_APP_ID: '',
    MSTEAMS_APP_PASSWORD: '',
    getConfigSnapshot: () => ({
      discord: {
        guilds: {},
      },
      msteams: {
        enabled: false,
      },
      email: {
        enabled: false,
      },
      whatsapp: {
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
      },
    }),
  }));
  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    getWhatsAppAuthStatus: vi.fn(async () => ({
      linked: false,
    })),
  }));

  const { checkChannels } = await import('../src/doctor/checks/channels.ts');
  const [result] = await checkChannels();

  expect(result.severity).toBe('ok');
  expect(result.message).toContain('intentionally disabled');
});

test('runDoctor rolls back prior fixes and skips later fixes after a failure', async () => {
  const applyConfigFix = vi.fn(async () => {});
  const rollbackConfigFix = vi.fn(async () => {});
  const applyDatabaseFix = vi.fn(async () => {
    throw new Error('migration failed');
  });
  const applyDockerFix = vi.fn(async () => {});

  vi.doMock('../src/doctor/checks/index.js', () => ({
    doctorChecks: () => [
      {
        category: 'config',
        label: 'Config',
        run: async () => [
          {
            category: 'config',
            label: 'Config',
            severity: 'warn',
            message: 'Config needs chmod',
            fix: {
              summary: 'Restrict config permissions',
              apply: applyConfigFix,
              rollback: rollbackConfigFix,
            },
          },
        ],
      },
      {
        category: 'database',
        label: 'Database',
        run: async () => [
          {
            category: 'database',
            label: 'Database',
            severity: 'warn',
            message: 'Schema migration available',
            fix: {
              summary: 'Run database migration',
              apply: applyDatabaseFix,
            },
          },
        ],
      },
      {
        category: 'docker',
        label: 'Docker',
        run: async () => [
          {
            category: 'docker',
            label: 'Docker',
            severity: 'warn',
            message: 'Image missing',
            fix: {
              summary: 'Build container image',
              apply: applyDockerFix,
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

  expect(applyConfigFix).toHaveBeenCalledTimes(1);
  expect(rollbackConfigFix).toHaveBeenCalledTimes(1);
  expect(applyDatabaseFix).toHaveBeenCalledTimes(1);
  expect(applyDockerFix).not.toHaveBeenCalled();
  expect(report.fixes).toEqual([
    {
      category: 'config',
      label: 'Config',
      status: 'applied',
      message: 'Restrict config permissions',
    },
    {
      category: 'database',
      label: 'Database',
      status: 'failed',
      message: 'migration failed',
    },
    {
      category: 'config',
      label: 'Config',
      status: 'rolled_back',
      message: 'Rolled back after a later fix failed',
    },
    {
      category: 'docker',
      label: 'Docker',
      status: 'skipped',
      message: 'Skipped after previous fix failure',
    },
  ]);
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
