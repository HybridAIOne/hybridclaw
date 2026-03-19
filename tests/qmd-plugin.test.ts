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

function installQmdPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'qmd-memory');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'qmd-memory');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeQmdStub(rootDir: string): string {
  const scriptPath = path.join(rootDir, 'mock-qmd.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'const command = args[0];',
      'if (command === "search" || command === "vsearch" || command === "query") {',
      '  console.log(JSON.stringify([',
      '    {',
      '      title: "Architecture Notes",',
      '      displayPath: "notes/architecture.md",',
      '      snippet: "Plugin commands are stored by the manager and need gateway dispatch.",',
      '      context: "Project docs",',
      '      score: 0.93',
      '    },',
      '    {',
      '      title: "Session Export Plan",',
      '      displayPath: "notes/session-export.md",',
      '      snippet: "Export transcripts as markdown so QMD can index prior conversations.",',
      '      score: 0.81',
      '    }',
      '  ]));',
      '  process.exit(0);',
      '}',
      'if (command === "status") {',
      '  console.log("Index ready\\nCollections: notes, sessions");',
      '  process.exit(0);',
      '}',
      'console.error(`unexpected command: ${command}`);',
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

test('QMD plugin injects external prompt context and exposes a status command', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
        maxResults: 2,
        maxSnippetChars: 120,
        maxInjectedChars: 600,
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
        content: 'Where are the plugin command hooks documented?',
        created_at: '2026-03-19T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain('External QMD knowledge search results:');
  expect(promptContext[0]).toContain('Architecture Notes');
  expect(promptContext[0]).toContain('notes/architecture.md');
  expect(promptContext[0]).toContain('Plugin commands are stored by the manager');

  const command = manager.findCommand('qmd');
  expect(command).toBeDefined();
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Index ready');
});

test('QMD plugin returns no extra context when the qmd command is unavailable', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: path.join(cwd, 'missing-qmd'),
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
    sessionId: 'session-2',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-2',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'What do the architecture notes say?',
        created_at: '2026-03-19T11:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toEqual([]);
});

test('QMD plugin exports session transcripts as markdown when enabled', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
        sessionExport: true,
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
  await manager.notifyTurnComplete({
    sessionId: 'session/export-test',
    userId: 'user-1',
    agentId: 'main',
    messages: [
      {
        id: 1,
        session_id: 'session/export-test',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Need QMD coverage.',
        created_at: '2026-03-19T12:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session/export-test',
        user_id: 'user-1',
        username: null,
        role: 'assistant',
        content: 'Implemented session transcript export.',
        created_at: '2026-03-19T12:00:10.000Z',
      },
    ],
  });

  const exportDir = path.join(cwd, '.hybridclaw', 'qmd-sessions');
  const exportPath = path.join(exportDir, 'session-export-test.md');
  expect(fs.existsSync(exportPath)).toBe(true);

  const exported = fs.readFileSync(exportPath, 'utf-8');
  expect(exported).toContain('sessionId: "session/export-test"');
  expect(exported).toContain('# HybridClaw Session session/export-test');
  expect(exported).toContain('Need QMD coverage.');
  expect(exported).toContain('Implemented session transcript export.');
});
