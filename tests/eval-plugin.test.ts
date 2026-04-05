import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('eval plugin runs MMLU with prompt ablations and saves a run record', async () => {
  const dataDir = makeTempDir('hybridclaw-evals-');
  const fetchMock = vi.fn(async () => ({
    ok: true,
    text: async () =>
      [
        '"What is 2+2?","1","2","4","5","C"',
        '"What color is the sky on a clear day?","Green","Blue","Red","Yellow","B"',
      ].join('\n'),
  }));
  vi.stubGlobal('fetch', fetchMock);

  const registeredCommands = [];
  const auditEvents = [];
  const dispatchInboundMessage = vi.fn(async () => ({
    status: 'success',
    result: 'B',
    toolsUsed: [],
  }));

  const plugin = (await import('../plugins/evals/src/index.js')).default;
  plugin.register({
    pluginId: 'evals',
    pluginDir: '/tmp/evals',
    registrationMode: 'full',
    config: {},
    pluginConfig: {
      dataDir,
      defaultSamples: 2,
      maxSamples: 10,
    },
    logger: {
      info: vi.fn(),
    },
    runtime: {
      cwd: process.cwd(),
      homeDir: dataDir,
      installRoot: process.cwd(),
      runtimeConfigPath: path.join(dataDir, 'config.json'),
    },
    registerCommand(command) {
      registeredCommands.push(command);
    },
    registerMemoryLayer() {},
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerService() {},
    registerInboundWebhook() {},
    dispatchInboundMessage,
    on() {},
    createAuditRunId() {
      return 'eval_run_test';
    },
    recordAuditEvent(event) {
      auditEvents.push(event);
    },
    resolvePath(relative) {
      return path.resolve('/tmp/evals', relative);
    },
    getCredential() {
      return undefined;
    },
  });

  expect(registeredCommands).toHaveLength(1);
  const handler = registeredCommands[0].handler;
  const text = await handler(
    [
      'mmlu',
      '--subject',
      'high_school_computer_science',
      '--n',
      '2',
      '--system-prompt',
      'minimal',
      '--no-soul',
    ],
    {
      sessionId: 'session-1',
      channelId: 'tui',
      userId: 'user-1',
      username: 'alice',
      guildId: null,
      agentId: 'main',
      chatbotId: 'bot-1',
      model: 'openai/gpt-5.4',
      enableRag: false,
      workspacePath: '/tmp/main/workspace',
    },
  );

  expect(dispatchInboundMessage).toHaveBeenCalledTimes(2);
  expect(dispatchInboundMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'openai/gpt-5.4',
      promptMode: 'minimal',
      promptAblation: {
        omitWorkspaceFiles: ['SOUL.md'],
      },
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(auditEvents.map((entry) => entry.event.type)).toEqual([
    'eval.run.started',
    'eval.case.completed',
    'eval.case.completed',
    'eval.run.completed',
  ]);
  expect(text).toContain('Eval complete: mmlu');
  expect(text).toContain('Prompt mode: minimal');
  expect(text).toContain('Prompt ablations: SOUL.md');

  const runFilePath = path.join(dataDir, 'runs', 'eval_run_test.json');
  expect(fs.existsSync(runFilePath)).toBe(true);
  const saved = JSON.parse(fs.readFileSync(runFilePath, 'utf-8'));
  expect(saved).toMatchObject({
    runId: 'eval_run_test',
    benchmark: 'mmlu',
    sampleCount: 2,
    model: 'openai/gpt-5.4',
    promptMode: 'minimal',
    promptAblation: {
      omitWorkspaceFiles: ['SOUL.md'],
    },
  });
});
