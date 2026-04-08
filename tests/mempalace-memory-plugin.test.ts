import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installBundledPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'mempalace-memory');
  const targetDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'mempalace-memory',
  );
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeMempalaceStub(rootDir: string): string {
  const scriptPath = path.join(rootDir, 'mock-mempalace.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const argv = process.argv.slice(2);',
      'let index = 0;',
      'let palacePath = "";',
      'while (index < argv.length && argv[index] === "--palace") {',
      '  palacePath = String(argv[index + 1] || "");',
      '  index += 2;',
      '}',
      'const command = String(argv[index] || "");',
      'const args = argv.slice(index + 1);',
      'if (command === "status") {',
      '  console.log("Palace ready at " + (palacePath || "~/.mempalace/palace"));',
      '  console.log("Wings: hybridclaw, docs");',
      '  process.exit(0);',
      '}',
      'if (command === "wake-up") {',
      '  const wingIndex = args.indexOf("--wing");',
      '  const wing = wingIndex >= 0 ? String(args[wingIndex + 1] || "") : "all";',
      '  console.log("Wake-up text (~140 tokens):");',
      '  console.log("==================================================");',
      '  console.log("TEAM: HybridClaw | ACTIVE_WING: " + wing);',
      '  console.log("DECISION: plugin.system->enabled | memory=external");',
      '  process.exit(0);',
      '}',
      'if (command === "search") {',
      '  const query = String(args[0] || "");',
      '  console.log("============================================================");',
      '  console.log("  Results for: \\"" + query + "\\"");',
      '  console.log("============================================================");',
      '  console.log("");',
      '  console.log("  [1] hybridclaw / auth-migration");',
      '  console.log("      Source: auth.md");',
      '  console.log("      Match:  0.941");',
      '  console.log("");',
      '  console.log("      We switched auth because Clerk reduced integration time.");',
      '  process.exit(0);',
      '}',
      'console.error("unexpected command: " + command);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

test('mempalace-memory injects wake-up and search context and exposes a command', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
        wakeUpWing: 'hybridclaw',
        maxResults: 2,
        maxWakeUpChars: 500,
        maxSearchChars: 1200,
        maxInjectedChars: 2000,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Why did we switch auth providers?',
        created_at: '2026-04-07T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain('MemPalace wake-up context:');
  expect(promptContext[0]).toContain('TEAM: HybridClaw');
  expect(promptContext[0]).toContain(
    'MemPalace search results for the latest user question:',
  );
  expect(promptContext[0]).toContain('We switched auth because Clerk');

  const command = manager.findCommand('mempalace');
  expect(command).toBeDefined();
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Palace ready at');
});
