import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
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
  if (ORIGINAL_HYBRIDAI_API_KEY === undefined) {
    delete process.env.HYBRIDAI_API_KEY;
  } else {
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
  }
  Object.defineProperty(process.stdin, 'isTTY', {
    value: ORIGINAL_STDIN_IS_TTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_STDOUT_IS_TTY,
    configurable: true,
  });
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

test('interactive onboarding does not print the start hint when TUI is already launching', async () => {
  const output = await runHybridAIOnboarding('hybridclaw tui');

  expect(output).not.toContain('Start HybridClaw now with `hybridclaw tui`.');
});

test('interactive onboarding does not print the start hint after auth login', async () => {
  const output = await runHybridAIOnboarding('hybridclaw auth login');

  expect(output).not.toContain('Start HybridClaw now with `hybridclaw tui`.');
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
