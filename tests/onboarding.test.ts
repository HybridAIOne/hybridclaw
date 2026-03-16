import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-onboarding-'));
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
  process.chdir(homeDir);
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
        question: vi.fn(async () => answers.shift() || ''),
        close: vi.fn(),
      }),
    },
  }));
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
  process.chdir(ORIGINAL_CWD);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: ORIGINAL_STDIN_IS_TTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_STDOUT_IS_TTY,
    configurable: true,
  });
});

test('interactive onboarding suggests starting the TUI after HybridAI setup', async () => {
  const output = await runHybridAIOnboarding('hybridclaw onboarding');

  expect(output).toContain('Start HybridClaw now with `hybridclaw tui`.');
});

test('interactive onboarding does not print the start hint when TUI is already launching', async () => {
  const output = await runHybridAIOnboarding('hybridclaw tui');

  expect(output).not.toContain('Start HybridClaw now with `hybridclaw tui`.');
});
