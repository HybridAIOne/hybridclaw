import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, test } from 'vitest';
import {
  EVOLVE_AGENT_SYSTEM_PROMPT,
  EVOLVE_AGENT_TOOLS,
} from '../eval-harness/src/harness-evolution.ts';
import { useTempDir } from './test-utils.ts';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HARNESS_CLI = path.join(ROOT, 'eval-harness', 'src', 'cli.ts');

const makeTempDir = useTempDir('hybridclaw-harness-evolve-');
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const MEMORY_EDIT = {
  surface: 'long_term_memory',
  relativePath: 'long_term_memory/stderr-debugging.md',
  content: '# stderr debugging\n\nRead stderr before retrying.\n',
  prediction: 'remember-stderr passes once memory mentions stderr',
  verifier: 'node check-memory.mjs',
  rollbackScope: 'long_term_memory/stderr-debugging.md',
};

interface ModelCall {
  url: string;
  model?: string;
  chatbotId?: string;
  authorization?: string;
  systemPrompt: string;
}

const EVOLVE_REPLY = `\`\`\`json\n${JSON.stringify({ f12Edits: [MEMORY_EDIT] })}\n\`\`\``;

// Plays the evolve agent behind the OpenAI-style, Anthropic, and Ollama chat
// endpoints. Every other GET (HybridAI bot/model lists, Anthropic model
// discovery) gets an empty 200 list, so health probes see a live provider.
async function startFakeModelServer(): Promise<{
  origin: string;
  calls: ModelCall[];
}> {
  const calls: ModelCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const url = req.url ?? '';
      if (url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'fake-evolver' }] }));
        return;
      }
      const isChat = /\/(chat\/completions|messages|api\/chat)$/.test(url);
      if (req.method !== 'POST' || !isChat) {
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const parsed = JSON.parse(body || '{}') as {
        model?: string;
        chatbot_id?: string;
        system?: string;
        messages?: Array<{ content?: string }>;
      };
      calls.push({
        url,
        model: parsed.model,
        chatbotId: parsed.chatbot_id,
        authorization: req.headers.authorization,
        systemPrompt: String(parsed.system ?? parsed.messages?.[0]?.content ?? ''),
      });
      if (url.endsWith('/messages')) {
        res.end(
          JSON.stringify({
            content: [{ type: 'text', text: EVOLVE_REPLY }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
        return;
      }
      if (url.endsWith('/api/chat')) {
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: EVOLVE_REPLY },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: parsed.model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: EVOLVE_REPLY },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, calls };
}

// Two configs a user really has: a dedicated `eval_judge` model on a local
// vLLM, or only HybridAI with its default model and no auxiliary override.
function vllmJudgeConfig(origin: string) {
  return {
    local: { backends: { vllm: { enabled: true, baseUrl: `${origin}/v1` } } },
    auxiliaryModels: {
      eval_judge: { provider: 'vllm', model: 'vllm/fake-evolver' },
    },
  };
}

function hybridaiOnlyConfig(origin: string) {
  return {
    hybridai: {
      baseUrl: origin,
      defaultModel: 'gpt-5',
      defaultChatbotId: 'bot_test',
    },
  };
}

// The default model on another provider, still with no `eval_judge` model.
// HybridAI points at a closed port, so only that provider can answer.
function defaultModelConfig(provider: 'anthropic' | 'ollama', origin: string) {
  return {
    hybridai: {
      baseUrl: 'http://127.0.0.1:9',
      defaultModel: `${provider}/fake-evolver`,
    },
    ...(provider === 'anthropic'
      ? { anthropic: { enabled: true, baseUrl: `${origin}/v1` } }
      : { local: { backends: { ollama: { enabled: true, baseUrl: origin } } } }),
  };
}

function writeFixture(dir: string, config: Record<string, unknown>) {
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  const target = path.join(dir, 'agent');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
  const checker = path.join(dir, 'check-memory.mjs');
  fs.writeFileSync(
    checker,
    [
      "import fs from 'node:fs';",
      'const file = `${process.argv[2]}/long_term_memory/stderr-debugging.md`;',
      "const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';",
      'if (!/stderr/i.test(text)) process.exit(1);',
    ].join('\n'),
  );
  const suite = path.join(dir, 'suite.json');
  fs.writeFileSync(
    suite,
    JSON.stringify({
      id: 'stderr-memory-smoke',
      name: 'stderr memory smoke',
      costBudgetUsd: 0.05,
      tasks: [
        { id: 'remember-stderr', command: `node ${checker} ${target}` },
      ],
    }),
  );
  return { dir, dataDir, home, target, suite };
}

type Fixture = ReturnType<typeof writeFixture>;

// A clean process env: no inherited provider keys or ~/.codex login, so the
// model chain sees only what the fixture configures.
function cliEnv(fixture: Fixture, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: fixture.home,
    HYBRIDCLAW_DATA_DIR: fixture.dataDir,
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
    GIT_AUTHOR_NAME: 'user_a',
    GIT_AUTHOR_EMAIL: 'user_a@example.com',
    GIT_COMMITTER_NAME: 'user_a',
    GIT_COMMITTER_EMAIL: 'user_a@example.com',
    ...extra,
  };
}

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      ...options,
      timeout: 90_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

function harnessEvolve(
  fixture: Fixture,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  return runCli(
    process.execPath,
    [TSX_CLI, HARNESS_CLI, 'harness-evolve', ...args],
    { cwd: ROOT, env: cliEnv(fixture, extraEnv) },
  );
}

function runArgs(fixture: Fixture, ...extra: string[]): string[] {
  const { target, suite } = fixture;
  return ['run', '--target', target, '--suite', suite, '--k', '1', ...extra];
}

function summaryPathOf(stdout: string): string {
  return /^Summary: (.+)$/m.exec(stdout)?.[1] ?? '';
}

function readMemory(target: string): string | null {
  const file = path.join(target, 'long_term_memory', 'stderr-debugging.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}

describe('npm run eval -- harness-evolve', () => {
  test('evolves a seed through an eval_judge model and inspects the run', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), vllmJudgeConfig(model.origin));
    const { target } = fixture;

    expect((await harnessEvolve(fixture, ['init', '--target', target])).code).toBe(0);
    const seed = await harnessEvolve(fixture, ['validate-seed', '--target', target]);
    expect(seed.code).toBe(0);
    expect(seed.stdout).toContain('minimal bash-only harness');

    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '2', '--fresh-seed'));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Best: round 2 pass@1=1');
    expect(model.calls.map((call) => call.model)).toEqual(['fake-evolver', 'fake-evolver']);
    expect(model.calls[0]?.systemPrompt).toBe(EVOLVE_AGENT_SYSTEM_PROMPT);
    expect(readMemory(target)).toMatch(/stderr/);

    const summaryPath = summaryPathOf(run.stdout);
    const list = await harnessEvolve(fixture, ['list', '--target', target]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`summary: ${summaryPath}`);
    expect(list.stdout).not.toContain('Incomplete runs');

    const status = await harnessEvolve(fixture, ['status', '--summary', summaryPath]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('long_term_memory:1');
    expect(status.stdout).toContain('edits from: evolve_agent via vllm vllm/fake-evolver');

    const manifest = await harnessEvolve(fixture, [
      'manifest',
      '--manifest',
      path.join(path.dirname(summaryPath), 'round-1', 'f12-manifest.json'),
    ]);
    expect(manifest.code).toBe(0);
    expect(JSON.parse(manifest.stdout).entries).toEqual([
      expect.objectContaining({
        surface: 'long_term_memory',
        path: MEMORY_EDIT.relativePath,
        confirmed: true,
      }),
    ]);
  }, 180_000);

  test('falls back to the HybridAI default model when no eval_judge is configured', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), hybridaiOnlyConfig(model.origin));
    const env = { HYBRIDAI_API_KEY: 'test-key' };

    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target], env)).code).toBe(0);
    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '1', '--fresh-seed'), env);

    expect(run.code, run.stderr).toBe(0);
    expect(model.calls).toEqual([
      expect.objectContaining({
        url: '/v1/chat/completions',
        model: 'gpt-5',
        chatbotId: 'bot_test',
      }),
    ]);
    expect(readMemory(fixture.target)).toMatch(/stderr/);
  }, 120_000);

  test('fails cleanly without any usable model and lists the run as incomplete', async () => {
    // Port 9 (discard) refuses connections: HybridAI is configured but down.
    const fixture = writeFixture(makeTempDir(), hybridaiOnlyConfig('http://127.0.0.1:9'));

    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target])).code).toBe(0);
    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '1'));
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^eval error: /m);

    const list = await harnessEvolve(fixture, ['list', '--target', fixture.target]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/: 0$/m);
    const [runId] = fs.readdirSync(path.join(fixture.target, 'runs'));
    expect(list.stdout).toMatch(new RegExp(`^Incomplete runs .*${runId}$`, 'm'));
  }, 120_000);

  test('--dry-run measures the seed without calling the model or editing surfaces', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), vllmJudgeConfig(model.origin));

    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target])).code).toBe(0);
    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '2', '--dry-run'));

    expect(run.code, run.stderr).toBe(0);
    expect(model.calls).toEqual([]);
    expect(readMemory(fixture.target)).toBeNull();
    expect(fs.existsSync(summaryPathOf(run.stdout))).toBe(true);
  }, 120_000);

  test('--commit records each evolved round as a git commit in the target', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), vllmJudgeConfig(model.origin));

    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target])).code).toBe(0);
    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '2', '--commit'));
    expect(run.code, run.stderr).toBe(0);

    const summary = JSON.parse(fs.readFileSync(summaryPathOf(run.stdout), 'utf-8')) as {
      rounds: Array<{ gitCommit: string | null }>;
    };
    const head = await runCli('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.target,
      env: cliEnv(fixture),
    });
    expect(summary.rounds[0]?.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(head.stdout.trim()).toBe(
      summary.rounds.map((round) => round.gitCommit).filter(Boolean).at(-1),
    );
    const tracked = await runCli('git', ['ls-files', 'long_term_memory'], {
      cwd: fixture.target,
      env: cliEnv(fixture),
    });
    expect(tracked.stdout.split('\n')).toContain(MEMORY_EDIT.relativePath);
  }, 120_000);

  test('resolves relative paths against the directory npm was run from', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), vllmJudgeConfig(model.origin));
    const npmEval = (args: string[]) =>
      runCli(
        'npm',
        ['--prefix', ROOT, 'run', '-s', 'eval', '--', 'harness-evolve', ...args],
        { cwd: fixture.dir, env: cliEnv(fixture) },
      );

    expect((await npmEval(['init', '--target', 'agent'])).code).toBe(0);
    expect(fs.existsSync(path.join(fixture.dir, 'agent', 'system_prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'agent'))).toBe(false);

    const run = await npmEval(['run', '--target', 'agent', '--suite', 'suite.json', '--rounds', '1', '--k', '1']);
    expect(run.code, run.stderr).toBe(0);
    expect(summaryPathOf(run.stdout).startsWith(path.join(fixture.dir, 'agent', 'runs'))).toBe(true);
  }, 180_000);

  test('labels a run that does not beat the best of an earlier run', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), vllmJudgeConfig(model.origin));
    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target])).code).toBe(0);
    expect((await harnessEvolve(fixture, runArgs(fixture, '--rounds', '2'))).code).toBe(0);

    // The memory edit is already in place, so this run starts at pass@1=1.
    const rerun = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '1'));
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain('Best: no round beat the prior best (pass@1=1)');

    const list = await harnessEvolve(fixture, ['list', '--target', fixture.target]);
    expect(list.stdout).toMatch(/rounds=1 {2}no new best \(prior pass@1=1\)/);
    expect(list.stdout).toMatch(/rounds=2 {2}best pass@1=1 \(round 2\)/);
  }, 180_000);

  // Without `eval_judge` the auxiliary chain runs: a healthy local model, then
  // the fixed remote fallback for each provider with credentials, and only then
  // the default model. So an Anthropic user gets the fixed Anthropic fallback.
  test.each([
    ['anthropic', '/v1/messages', 'claude-haiku-4-5', { ANTHROPIC_API_KEY: 'test-key' }],
    ['ollama', '/api/chat', 'fake-evolver', {}],
  ] as const)('without eval_judge, a %s default model setup reaches %s', async (provider, url, sentModel, env) => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), defaultModelConfig(provider, model.origin));

    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target], env)).code).toBe(0);
    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '1', '--fresh-seed'), env);

    expect(run.code, run.stderr).toBe(0);
    expect(model.calls).toEqual([
      expect.objectContaining({ url, model: sentModel, systemPrompt: EVOLVE_AGENT_SYSTEM_PROMPT }),
    ]);
    expect(run.stdout).toMatch(new RegExp(`edits from: evolve_agent via ${provider} `));
    expect(readMemory(fixture.target)).toMatch(/stderr/);
  }, 120_000);

  test('uses a HybridAI API key from the encrypted credential store', async () => {
    const model = await startFakeModelServer();
    const fixture = writeFixture(makeTempDir(), hybridaiOnlyConfig(model.origin));
    const storeScript = path.join(fixture.dir, 'store-key.mts');
    fs.writeFileSync(
      storeScript,
      [
        `import { saveRuntimeSecrets } from ${JSON.stringify(path.join(ROOT, 'src/security/runtime-secrets.ts'))};`,
        "saveRuntimeSecrets({ HYBRIDAI_API_KEY: 'test-key' });",
      ].join('\n'),
    );
    const stored = await runCli(process.execPath, [TSX_CLI, storeScript], {
      cwd: fixture.dir,
      env: cliEnv(fixture),
    });
    expect(stored.code, stored.stderr).toBe(0);
    const credentials = fs.readFileSync(path.join(fixture.dataDir, 'credentials.json'), 'utf-8');
    expect(credentials).not.toContain('test-key');

    expect((await harnessEvolve(fixture, ['init', '--target', fixture.target])).code).toBe(0);
    const run = await harnessEvolve(fixture, runArgs(fixture, '--rounds', '1', '--fresh-seed'));

    expect(run.code, run.stderr).toBe(0);
    expect(model.calls).toEqual([
      expect.objectContaining({ model: 'gpt-5', authorization: 'Bearer test-key' }),
    ]);
  }, 120_000);

  // Artifacts from a real `hybridclaw harness-evolve run` on v0.39.1, with the
  // target path replaced by a placeholder that the test points at a copy.
  test('lists and reads runs written by hybridclaw v0.39.1', async () => {
    const fixture = writeFixture(makeTempDir(), {});
    const source = path.join(ROOT, 'tests', 'fixtures', 'harness-evolution-v0.39.1');
    fs.cpSync(source, fixture.target, { recursive: true });
    const runDir = path.join(fixture.target, 'runs', 'evolve-2026-10-08T18-31-00-161Z');
    for (const file of ['summary.json', 'list-entry.json', 'round-1/f12-manifest.json', 'round-2/f12-manifest.json']) {
      const filePath = path.join(runDir, file);
      const text = fs.readFileSync(filePath, 'utf-8');
      fs.writeFileSync(filePath, text.replaceAll('/tmp/hc-evolve-agent', fixture.target));
    }

    const list = await harnessEvolve(fixture, ['list', '--target', fixture.target]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/^evolve-2026-10-08T18-31-00-161Z {2}stderr memory smoke {2}rounds=2 {2}best pass@1=1 \(round 2\)/m);
    expect(list.stdout).toContain(`summary: ${path.join(runDir, 'summary.json')}`);

    const status = await harnessEvolve(fixture, ['status', '--summary', path.join(runDir, 'summary.json')]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain('Best: round 2 pass@1=1');
    expect(status.stdout).toContain('edits from: evolve_agent via vllm vllm/fake-evolver');

    const manifest = await harnessEvolve(fixture, ['manifest', '--manifest', path.join(runDir, 'round-2', 'f12-manifest.json')]);
    expect(manifest.code, manifest.stderr).toBe(0);
    expect(JSON.parse(manifest.stdout).entries).toEqual([
      expect.objectContaining({ surface: 'long_term_memory', path: MEMORY_EDIT.relativePath }),
    ]);
  }, 60_000);

  test('ignores an INIT_CWD it did not get from `npm run eval`', async () => {
    const fixture = writeFixture(makeTempDir(), {});
    const elsewhere = makeTempDir();
    const result = await runCli(
      process.execPath,
      [TSX_CLI, HARNESS_CLI, 'harness-evolve', 'init', '--target', 'agent'],
      { cwd: fixture.dir, env: cliEnv(fixture, { INIT_CWD: elsewhere }) },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fixture.dir, 'agent', 'system_prompt.md'))).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  }, 60_000);

  test.each([['run', '--help'], ['init', '-h'], ['status', '--summary', 'x', '--help']])(
    'prints subcommand usage for %j',
    async (...args) => {
      const result = await harnessEvolve(writeFixture(makeTempDir(), {}), args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^Usage: npm run eval -- harness-evolve ${args[0]} --`));
    },
    60_000,
  );

  test('contract prints the evolve-agent prompt and tool schema', async () => {
    const result = await harnessEvolve(writeFixture(makeTempDir(), {}), ['contract']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      systemPrompt: EVOLVE_AGENT_SYSTEM_PROMPT,
      tools: EVOLVE_AGENT_TOOLS,
    });
  }, 60_000);

  test('help lists every subcommand, and the eval usage lists harness-evolve', async () => {
    const fixture = writeFixture(makeTempDir(), {});
    const help = await harnessEvolve(fixture, ['help']);
    expect(help.code).toBe(0);
    for (const sub of ['init', 'validate-seed', 'run', 'list', 'status', 'manifest', 'contract']) {
      expect(help.stdout).toMatch(new RegExp(`^ {2}harness-evolve ${sub}\\b`, 'm'));
    }

    const evalHelp = await runCli(process.execPath, [TSX_CLI, HARNESS_CLI, 'help'], {
      cwd: ROOT,
      env: cliEnv(fixture),
    });
    expect(evalHelp.code, evalHelp.stderr).toBe(0);
    expect(evalHelp.stdout).toMatch(/npm run eval -- harness-evolve /);
  }, 60_000);

  test.each([
    [['bogus'], /Unknown harness-evolve subcommand: bogus/],
    [['list', '--nope'], /Unknown option '--nope'/],
    [['init', '--target', 'x', '--commit'], /Unknown option '--commit'/],
    [['run', '--target', 'x', '--suite', 'y', '--manifest', 'z'], /Unknown option '--manifest'/],
    [['status', '--target', 'x'], /Unknown option '--target'/],
    [['run', '--target', 'x'], /Usage: harness-evolve run/],
    [['run', '--target', 'x', '--suite', 'y', '--k', '0'], /--k must be a positive integer/],
  ])('rejects %j', async (args, message) => {
    const result = await harnessEvolve(writeFixture(makeTempDir(), {}), args);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
  }, 60_000);
});
