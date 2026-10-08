import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, test } from 'vitest';
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

// A vLLM-compatible chat endpoint that plays the evolve agent.
async function startFakeModelServer(): Promise<{
  baseUrl: string;
  systemPrompts: string[];
}> {
  const systemPrompts: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        model?: string;
        messages?: Array<{ content?: string }>;
      };
      systemPrompts.push(String(parsed.messages?.[0]?.content || ''));
      const content = `\`\`\`json\n${JSON.stringify({ f12Edits: [MEMORY_EDIT] })}\n\`\`\``;
      res.writeHead(200, { 'content-type': 'application/json' });
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
              message: { role: 'assistant', content },
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
  return { baseUrl: `http://127.0.0.1:${port}/v1`, systemPrompts };
}

function writeFixture(dir: string, modelBaseUrl: string) {
  const dataDir = path.join(dir, 'data');
  const target = path.join(dir, 'agent');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      local: { backends: { vllm: { enabled: true, baseUrl: modelBaseUrl } } },
      auxiliaryModels: {
        eval_judge: { provider: 'vllm', model: 'vllm/fake-evolver' },
      },
    }),
  );
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
  return { dataDir, target, suite };
}

async function harnessEvolve(
  dataDir: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [TSX_CLI, HARNESS_CLI, 'harness-evolve', ...args],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          HYBRIDCLAW_DATA_DIR: dataDir,
          HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
        },
        timeout: 60_000,
      },
    );
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

describe('npm run eval -- harness-evolve', () => {
  test('evolves a seed through a real model endpoint and inspects the run', async () => {
    const dir = makeTempDir();
    const model = await startFakeModelServer();
    const { dataDir, target, suite } = writeFixture(dir, model.baseUrl);

    expect((await harnessEvolve(dataDir, ['init', '--target', target])).code).toBe(0);
    const seed = await harnessEvolve(dataDir, ['validate-seed', '--target', target]);
    expect(seed.code).toBe(0);
    expect(seed.stdout).toContain('minimal bash-only harness');

    const run = await harnessEvolve(dataDir, [
      'run',
      '--target',
      target,
      '--suite',
      suite,
      '--rounds',
      '2',
      '--k',
      '1',
      '--fresh-seed',
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Best: round 2 pass@1=1');
    expect(model.systemPrompts).toHaveLength(2);
    expect(model.systemPrompts[0]).toMatch(/harness-evolution agent/);
    expect(
      fs.readFileSync(
        path.join(target, 'long_term_memory', 'stderr-debugging.md'),
        'utf-8',
      ),
    ).toMatch(/stderr/);

    const summaryPath = /^Summary: (.+)$/m.exec(run.stdout)?.[1] ?? '';
    const list = await harnessEvolve(dataDir, ['list', '--target', target]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`summary: ${summaryPath}`);

    const status = await harnessEvolve(dataDir, ['status', '--summary', summaryPath]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('long_term_memory:1');

    const manifest = await harnessEvolve(dataDir, [
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
  }, 120_000);

  test.each([
    [['bogus'], /Unknown harness-evolve subcommand: bogus/],
    [['list', '--nope'], /Unknown option '--nope'/],
    [['run', '--target', 'x'], /Usage: harness-evolve run/],
    [['run', '--target', 'x', '--suite', 'y', '--k', '0'], /--k must be a positive integer/],
  ])('rejects %j', async (args, message) => {
    const result = await harnessEvolve(makeTempDir(), args);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
  }, 60_000);
});
