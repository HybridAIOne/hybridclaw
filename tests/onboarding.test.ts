import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
// Provider credential variables that the onboarding tests delete (so onboarding
// prompts for them) and must therefore restore in teardown — otherwise clearing
// one here would leak into later tests in the same Vitest process.
const PROVIDER_API_KEY_ENV_VARS = [
  'HYBRIDAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
] as const;
const ORIGINAL_PROVIDER_API_KEY_ENV = new Map<string, string | undefined>(
  PROVIDER_API_KEY_ENV_VARS.map((name) => [name, process.env[name]]),
);
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
const ORIGINAL_CWD = process.cwd();
const TEMP_HOMES: string[] = [];

function makeTempHome(): string {
  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-onboarding-'),
  );
  TEMP_HOMES.push(homeDir);
  return homeDir;
}

function writeRuntimeConfig(
  homeDir: string,
  mutator?: (config: RuntimeConfig) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.ops.dbPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'hybridclaw.db',
  );
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function runHybridAIOnboarding(commandName: string): Promise<string> {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const answers = ['n', 'n', '', '', 'hai-testkey1234567890', ''];
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));
  vi.doMock('../src/security/runtime-secrets.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets.ts')
    >('../src/security/runtime-secrets.ts');
    return {
      ...actual,
      loadRuntimeSecrets: (targetHomeDir?: string) =>
        actual.loadRuntimeSecrets(targetHomeDir ?? homeDir, homeDir),
    };
  });
  vi.doMock('../src/security/runtime-secrets-bootstrap.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets-bootstrap.ts')
    >('../src/security/runtime-secrets-bootstrap.ts');
    return {
      ...actual,
      bootstrapRuntimeSecrets: (targetHomeDir?: string) =>
        actual.bootstrapRuntimeSecrets(targetHomeDir ?? homeDir),
    };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'b2878bba-24c1-46ce-89b6-49e860c6502f',
                name: 'My Assistant',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ),
  );
  vi.resetModules();

  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });
  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName,
    preferredAuth: 'hybridai',
  });

  return lines.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('node:readline/promises');
  vi.doUnmock('../src/security/runtime-secrets.ts');
  vi.doUnmock('../src/security/runtime-secrets-bootstrap.ts');
  vi.doUnmock('../src/utils/secret-prompt.js');
  vi.doUnmock('../src/utils/secret-prompt.ts');
  vi.doUnmock('../src/migration/agent-home-migration.js');
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_DISABLE_CONFIG_WATCHER === undefined) {
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  } else {
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER =
      ORIGINAL_DISABLE_CONFIG_WATCHER;
  }
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    const original = ORIGINAL_PROVIDER_API_KEY_ENV.get(name);
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
  Object.defineProperty(process.stdin, 'isTTY', {
    value: ORIGINAL_STDIN_IS_TTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_STDOUT_IS_TTY,
    configurable: true,
  });
  process.chdir(ORIGINAL_CWD);
  while (TEMP_HOMES.length > 0) {
    const homeDir = TEMP_HOMES.pop();
    if (!homeDir) continue;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('interactive onboarding suggests starting the TUI after HybridAI setup', async () => {
  const output = await runHybridAIOnboarding('hybridclaw onboarding');

  expect(output).toContain('Start HybridClaw now with `hybridclaw tui`.');
});

test('interactive onboarding offers last-known-good restore when runtime config is invalid JSON', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  vi.resetModules();
  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.writeFileSync(
    configPath,
    '{\n  "security": {\n    "trustModelAccepted": true,\n  }\n}\n',
    'utf-8',
  );
  expect(() =>
    runtimeConfig.reloadRuntimeConfig('test-invalid-config'),
  ).toThrow(/Failed to reload runtime config/);

  const answers = ['y'];
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });
  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw gateway restart --foreground',
    requireCredentials: false,
  });

  const output = lines.join('\n');
  expect(output).toContain('Runtime config error');
  expect(output).toContain(
    'Restored runtime config from the last known-good saved snapshot',
  );
  expect(output).not.toContain('Security trust model acceptance');
  expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toMatchObject({
    security: {
      trustModelAccepted: true,
      trustModelVersion: '2026-02-28',
    },
  });
});

test('declining invalid runtime config restore only loads revision metadata', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  vi.resetModules();
  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.writeFileSync(
    configPath,
    '{\n  "security": {\n    "trustModelAccepted": true,\n  }\n}\n',
    'utf-8',
  );
  expect(() =>
    runtimeConfig.reloadRuntimeConfig('test-invalid-config'),
  ).toThrow(/Failed to reload runtime config/);

  const getLastKnownGoodMetadataSpy = vi.spyOn(
    runtimeConfig,
    'getLastKnownGoodRuntimeConfigMetadata',
  );
  const getLastKnownGoodStateSpy = vi.spyOn(
    runtimeConfig,
    'getLastKnownGoodRuntimeConfigState',
  );
  const listRevisionsSpy = vi.spyOn(
    runtimeConfig,
    'listRuntimeConfigRevisions',
  );

  const answers = ['n'];
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });
  const onboarding = await import('../src/onboarding.ts');
  const resultPromise = onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw gateway restart --foreground',
    requireCredentials: false,
  });

  await expect(resultPromise).rejects.toThrow(/Failed to load runtime config/);
  await expect(resultPromise).rejects.toThrow(
    /last known-good saved config snapshot/,
  );
  expect(getLastKnownGoodMetadataSpy).toHaveBeenCalledTimes(1);
  expect(getLastKnownGoodStateSpy).not.toHaveBeenCalled();
  expect(listRevisionsSpy).not.toHaveBeenCalled();
  expect(lines.join('\n')).toContain('Runtime config error');
});

test('first-run onboarding offers Hermes migration before auth setup', async () => {
  const homeDir = makeTempHome();
  const hermesRoot = path.join(homeDir, '.hermes');
  fs.mkdirSync(hermesRoot, { recursive: true });
  fs.writeFileSync(
    path.join(hermesRoot, '.env'),
    'HYBRIDAI_API_KEY=hai-imported-from-hermes\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(hermesRoot, 'SOUL.md'),
    '# SOUL.md\n\nImported from Hermes.\n',
    'utf-8',
  );

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const answers = [
    'y',
    'y',
    'ACCEPT',
    '',
    'n',
    'n',
    '',
    '',
    'hai-imported-from-hermes',
    '',
  ];
  const migrateAgentHomeMock = vi.fn(async () => {
    const runtimeRoot = path.join(homeDir, '.hybridclaw');
    process.env.HOME = homeDir;
    const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
    fs.mkdirSync(
      path.join(runtimeRoot, 'data', 'agents', 'main', 'workspace'),
      {
        recursive: true,
      },
    );
    fs.mkdirSync(path.join(runtimeRoot, 'migration', 'hermes', 'test-run'), {
      recursive: true,
    });
    runtimeSecrets.saveRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-imported-from-hermes',
    });
    process.env.HYBRIDAI_API_KEY = 'hai-imported-from-hermes';
    return {
      sourceKind: 'hermes',
      sourceRoot: hermesRoot,
      targetRoot: runtimeRoot,
      execute: true,
      overwrite: false,
      migrateSecrets: true,
      outputDir: path.join(runtimeRoot, 'migration', 'hermes', 'test-run'),
      summary: {
        total: 2,
        migrated: 2,
        skipped: 0,
        conflict: 0,
        error: 0,
        archived: 0,
      },
      items: [],
    };
  });
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));
  vi.doMock('../src/migration/agent-home-migration.js', () => ({
    detectAvailableAgentMigrationSources: () => ['hermes'],
    detectAgentMigrationSourceRoot: () => hermesRoot,
    migrateAgentHome: migrateAgentHomeMock,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'user-42',
                name: 'Imported Assistant',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ),
  );
  vi.resetModules();

  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw onboarding',
    preferredAuth: 'hybridai',
  });

  const runtimeRoot = path.join(homeDir, '.hybridclaw');
  expect(fs.existsSync(path.join(runtimeRoot, 'credentials.json'))).toBe(true);
  expect(
    fs.readFileSync(path.join(runtimeRoot, 'credentials.json'), 'utf-8'),
  ).not.toContain('hai-imported-from-hermes');
  expect(migrateAgentHomeMock).toHaveBeenCalled();
});

test('non-interactive onboarding reports invalid runtime config before trust acceptance', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });

  vi.resetModules();
  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.writeFileSync(configPath, '{ not valid json !!!', 'utf-8');
  expect(() =>
    runtimeConfig.reloadRuntimeConfig('test-invalid-config'),
  ).toThrow(/Failed to reload runtime config/);

  const onboarding = await import('../src/onboarding.ts');
  const resultPromise = onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw gateway restart --foreground',
    requireCredentials: false,
  });
  await expect(resultPromise).rejects.toThrow(/Failed to load runtime config/);
  await expect(resultPromise).rejects.toThrow(/hybridclaw onboarding/);
  await expect(resultPromise).rejects.toThrow(
    /last known-good saved config snapshot/,
  );
});

test('interactive onboarding does not print the start hint when TUI is already launching', async () => {
  const output = await runHybridAIOnboarding('hybridclaw tui');

  expect(output).not.toContain('Start HybridClaw now with `hybridclaw tui`.');
});

test('tui bootstrap does not prompt for remote auth when trust is already accepted', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.defaultModel = 'mistral/mistral-large-latest';
  });

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const questionSpy = vi.fn(async () => {
    throw new Error('Unexpected onboarding prompt');
  });
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: questionSpy,
        close: vi.fn(),
      }),
    },
  }));
  vi.resetModules();

  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });
  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw tui',
    requireCredentials: false,
  });

  expect(questionSpy).not.toHaveBeenCalled();
  expect(lines.join('\n')).not.toContain('Choose auth method');
});

test('interactive onboarding does not print the start hint after auth login', async () => {
  const output = await runHybridAIOnboarding('hybridclaw auth login');

  expect(output).not.toContain('Start HybridClaw now with `hybridclaw tui`.');
});

test('interactive onboarding lets users skip remote auth for local models', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const answers = ['7'];
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));
  vi.doMock('../src/security/runtime-secrets.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets.ts')
    >('../src/security/runtime-secrets.ts');
    return {
      ...actual,
      loadRuntimeSecrets: (targetHomeDir?: string) =>
        actual.loadRuntimeSecrets(targetHomeDir ?? homeDir, homeDir),
    };
  });
  vi.doMock('../src/security/runtime-secrets-bootstrap.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets-bootstrap.ts')
    >('../src/security/runtime-secrets-bootstrap.ts');
    return {
      ...actual,
      bootstrapRuntimeSecrets: (targetHomeDir?: string) =>
        actual.bootstrapRuntimeSecrets(targetHomeDir ?? homeDir),
    };
  });
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();

  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });
  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw onboarding',
  });

  const output = lines.join('\n');
  expect(output).toContain('Skip for now (for local models)');
  expect(output).toContain('Skipping remote provider auth for now.');
  expect(output).toContain(
    'hybridclaw auth login local llamacpp --base-url http://127.0.0.1:8081',
  );
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('interactive onboarding prompts for configured speech-to-text provider credentials', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
    config.local.backends.vllm.enabled = false;
    config.hybridai.defaultModel = 'lmstudio/qwen/qwen3.5-9b';
    config.skills.speechToText = { defaultProvider: 'deepgram' };
  });

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  process.chdir(homeDir);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const answers = ['y'];
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));
  vi.doMock('../src/utils/secret-prompt.js', () => ({
    promptForSecretInput: vi.fn(async () => 'dg-test-key'),
  }));
  vi.doMock('../src/security/runtime-secrets.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets.ts')
    >('../src/security/runtime-secrets.ts');
    return {
      ...actual,
      loadRuntimeSecrets: (targetHomeDir?: string) =>
        actual.loadRuntimeSecrets(targetHomeDir ?? homeDir, homeDir),
    };
  });
  vi.doMock('../src/security/runtime-secrets-bootstrap.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets-bootstrap.ts')
    >('../src/security/runtime-secrets-bootstrap.ts');
    return {
      ...actual,
      bootstrapRuntimeSecrets: (targetHomeDir?: string) =>
        actual.bootstrapRuntimeSecrets(targetHomeDir ?? homeDir),
    };
  });
  vi.resetModules();

  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });
  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw onboarding',
  });

  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
  expect(runtimeSecrets.readStoredRuntimeSecret('DEEPGRAM_API_KEY')).toBe(
    'dg-test-key',
  );
  expect(lines.join('\n')).toContain(
    'Deepgram speech-to-text credentials saved.',
  );
});

test('interactive HybridAI onboarding defaults the saved bot to the account chatbot id', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const answers = ['n', 'n', '', '', 'hai-testkey1234567890', ''];
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: () => ({
        question: vi.fn(async (prompt: string) => {
          const answer = answers.shift();
          if (answer === undefined) {
            throw new Error(`Unexpected onboarding prompt: ${prompt}`);
          }
          return answer;
        }),
        close: vi.fn(),
      }),
    },
  }));
  vi.doMock('../src/security/runtime-secrets.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets.ts')
    >('../src/security/runtime-secrets.ts');
    return {
      ...actual,
      loadRuntimeSecrets: (targetHomeDir?: string) =>
        actual.loadRuntimeSecrets(targetHomeDir ?? homeDir, homeDir),
    };
  });
  vi.doMock('../src/security/runtime-secrets-bootstrap.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/security/runtime-secrets-bootstrap.ts')
    >('../src/security/runtime-secrets-bootstrap.ts');
    return {
      ...actual,
      bootstrapRuntimeSecrets: (targetHomeDir?: string) =>
        actual.bootstrapRuntimeSecrets(targetHomeDir ?? homeDir),
    };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/bot-management/me')) {
        return new Response(JSON.stringify({ user_id: 'user-42' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'b2878bba-24c1-46ce-89b6-49e860c6502f',
              name: 'My Assistant',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }),
  );
  vi.resetModules();

  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw onboarding',
    preferredAuth: 'hybridai',
  });

  expect(runtimeConfig.getRuntimeConfig().hybridai.defaultChatbotId).toBe(
    'user-42',
  );
});

test('ensureRuntimeCredentials backfills the default HybridAI bot from account fallback when credentials already exist', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  process.env.HYBRIDAI_API_KEY = 'hai-existing1234567890';
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/bot-management/me')) {
        return new Response(JSON.stringify({ user_id: 'user-42' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected onboarding fetch: ${url}`);
    }),
  );
  vi.resetModules();

  const runtimeConfig = await import('../src/config/runtime-config.ts');
  runtimeConfig.acceptSecurityTrustModel({
    acceptedAt: '2026-03-10T10:00:00.000Z',
    acceptedBy: 'test',
  });

  const onboarding = await import('../src/onboarding.ts');
  await onboarding.ensureRuntimeCredentials({
    commandName: 'hybridclaw tui',
  });

  expect(runtimeConfig.getRuntimeConfig().hybridai.defaultChatbotId).toBe(
    'user-42',
  );
});

const MASKED_PROVIDER_CASES = [
  {
    name: 'Anthropic',
    preferredAuth: 'anthropic' as const,
    secretName: 'ANTHROPIC_API_KEY',
    maskedValue: 'anthropic-masked-secret-key',
  },
  {
    name: 'OpenRouter',
    preferredAuth: 'openrouter' as const,
    secretName: 'OPENROUTER_API_KEY',
    maskedValue: 'or-masked-secret-key',
  },
  {
    name: 'Mistral',
    preferredAuth: 'mistral' as const,
    secretName: 'MISTRAL_API_KEY',
    maskedValue: 'mistral-masked-secret-key',
  },
  {
    name: 'Hugging Face',
    preferredAuth: 'huggingface' as const,
    secretName: 'HF_TOKEN',
    maskedValue: 'hf-masked-secret-token',
  },
];

test.each(MASKED_PROVIDER_CASES)(
  'interactive onboarding reads the $name credential through the hidden secret prompt',
  async ({ preferredAuth, secretName, maskedValue }) => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);

    process.env.HOME = homeDir;
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
    delete process.env.HYBRIDAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.HUGGINGFACE_API_KEY;
    process.chdir(homeDir);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    // The plain readline interface only answers the non-secret prompts: keep the
    // configured Anthropic auth method and decline the default-model switch. If a
    // provider ever stopped masking its key prompt it would fall through to this
    // mock instead of `promptForSecretInput`, and the assertions below would fail.
    vi.doMock('node:readline/promises', () => ({
      default: {
        createInterface: () => ({
          question: vi.fn(async (prompt: string) =>
            /auth method/i.test(prompt) ? '' : 'n',
          ),
          close: vi.fn(),
        }),
      },
    }));
    vi.doMock('../src/utils/secret-prompt.js', () => ({
      promptForSecretInput: vi.fn(async () => maskedValue),
    }));
    vi.doMock('../src/security/runtime-secrets.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/security/runtime-secrets.ts')
      >('../src/security/runtime-secrets.ts');
      return {
        ...actual,
        loadRuntimeSecrets: (targetHomeDir?: string) =>
          actual.loadRuntimeSecrets(targetHomeDir ?? homeDir, homeDir),
      };
    });
    vi.doMock('../src/security/runtime-secrets-bootstrap.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/security/runtime-secrets-bootstrap.ts')
      >('../src/security/runtime-secrets-bootstrap.ts');
      return {
        ...actual,
        bootstrapRuntimeSecrets: (targetHomeDir?: string) =>
          actual.bootstrapRuntimeSecrets(targetHomeDir ?? homeDir),
      };
    });
    vi.resetModules();

    const runtimeConfig = await import('../src/config/runtime-config.ts');
    runtimeConfig.acceptSecurityTrustModel({
      acceptedAt: '2026-03-10T10:00:00.000Z',
      acceptedBy: 'test',
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const onboarding = await import('../src/onboarding.ts');
    await onboarding.ensureRuntimeCredentials({
      commandName: 'hybridclaw onboarding',
      preferredAuth,
    });

    const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
    const secretPrompt = await import('../src/utils/secret-prompt.js');
    expect(secretPrompt.promptForSecretInput).toHaveBeenCalled();
    expect(runtimeSecrets.readStoredRuntimeSecret(secretName)).toBe(maskedValue);
  },
);
