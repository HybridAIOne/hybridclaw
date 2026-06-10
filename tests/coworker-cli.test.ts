import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-coworker-cli-'));
}

async function importFreshCli(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/cli.ts');
}

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function writeSource(homeDir: string, name: string, content: string): string {
  const filePath = path.join(homeDir, 'sources', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function workspaceDir(homeDir: string, agentId: string): string {
  return path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'agents',
    agentId,
    'workspace',
  );
}

test('coworker distill against a real person is blocked until consent is recorded, then produces run.json + REPORT.md', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const source = writeSource(
    homeDir,
    'memo.md',
    '# Decisions\n\nBoring options win until measured otherwise.',
  );

  await cli.main([
    'coworker',
    'distill',
    '--alias',
    'maya',
    '--name',
    'Maya Lindqvist',
    '--source',
    source,
  ]);
  expect(process.exitCode).toBe(1);
  const errorOutput = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  expect(errorOutput).toContain('blocked');
  expect(errorOutput).toContain('coworker consent record');
  process.exitCode = 0;

  await cli.main([
    'coworker',
    'consent',
    'record',
    '--alias',
    'maya',
    '--granted-by',
    'Maya Lindqvist',
    '--method',
    'written',
    '--statement',
    'I consent to distillation.',
  ]);

  await cli.main([
    'coworker',
    'distill',
    '--alias',
    'maya',
    '--source',
    source,
    '--holdout',
    '0',
  ]);
  const runsRoot = path.join(
    workspaceDir(homeDir, 'maya'),
    'runtime',
    'distill',
  );
  const runDirs = fs.readdirSync(runsRoot);
  expect(runDirs).toHaveLength(1);
  expect(fs.existsSync(path.join(runsRoot, runDirs[0], 'run.json'))).toBe(true);
  expect(fs.existsSync(path.join(runsRoot, runDirs[0], 'REPORT.md'))).toBe(
    true,
  );
  const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  expect(output).toContain('awaiting-extraction');
  expect(output).toContain('--resume');
});

test('coworker interview writes a gap-driven questionnaire and status reports corpus state', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const source = writeSource(homeDir, 'memo.md', '# Memo\n\nShort note.');

  await cli.main([
    'coworker',
    'distill',
    '--alias',
    'nova',
    '--name',
    'Nova',
    '--fictional',
    '--source',
    source,
    '--holdout',
    '0',
  ]);

  const questionnairePath = path.join(homeDir, 'interview.md');
  await cli.main([
    'coworker',
    'interview',
    '--alias',
    'nova',
    '--audience',
    'colleague',
    '--count',
    '6',
    '--out',
    questionnairePath,
  ]);
  const questionnaire = fs.readFileSync(questionnairePath, 'utf-8');
  expect(questionnaire).toContain('**Q1');
  expect(questionnaire).toContain('**A:**');
  expect(questionnaire).toContain('Nova');
  expect(questionnaire).toContain('--kind interview');

  logSpy.mockClear();
  await cli.main(['coworker', 'status', '--alias', 'nova']);
  const statusOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  expect(statusOutput).toContain('Coworker: Nova');
  expect(statusOutput).toContain('fictional');
  expect(statusOutput).toContain('Corpus: 1 documents');
});

test('coworker forget requires --confirm and unknown subcommands fail with usage', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const source = writeSource(homeDir, 'memo.md', '# Memo\n\nNote.');
  await cli.main([
    'coworker',
    'distill',
    '--alias',
    'nova',
    '--fictional',
    '--source',
    source,
  ]);
  await expect(
    cli.main(['coworker', 'forget', '--alias', 'nova']),
  ).rejects.toThrow(/--confirm/);
  await expect(cli.main(['coworker', 'frobnicate'])).rejects.toThrow(
    /Unknown coworker subcommand/,
  );
});
