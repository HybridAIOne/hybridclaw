import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withTemporaryDirectory } from './temporary.mjs';

const credential = 'fixture-provider-credential-123456';
async function runFixture(providerSource, extra, inspect) {
  return withTemporaryDirectory('hy-gym-runner-test-', async (home) => {
    const writeModule = (name, content) => {
      const path = `${home}/${name}`;
      fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(path, content);
    };
    writeModule('package.json', '{"type":"module"}');
    writeModule(
      'src/config/config.ts',
      "export const HYBRIDAI_MODEL = 'fixture-model';",
    );
    writeModule(
      'src/providers/factory.ts',
      `export async function resolveModelRuntimeCredentials() { return { provider: 'hybridai', apiKey: '${credential}' }; }`,
    );
    writeModule('container/src/providers/hybridai.ts', providerSource);
    writeModule(
      'src/agent/mobile-prompt.ts',
      "export const CHAT_REPLY_LINES = ['fixture-prompt'];",
    );
    writeModule(
      'src/agent/prompt-hooks.ts',
      "export function buildSystemPromptFromHooks() { return 'fixture-prompt'; }",
    );
    const output = `${home}/result.jsonl`;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./run.mjs', import.meta.url)),
        '--variant',
        'candidate',
        '--scenario',
        'leasing',
        '--output',
        output,
        ...extra,
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          HY_GYM_ISOLATED: '1',
          HY_GYM_RUNTIME_ROOT: home,
          HYBRIDCLAW_DATA_DIR: home,
        },
        encoding: 'utf8',
      },
    );
    const recorded = fs.existsSync(output)
      ? fs.readFileSync(output, 'utf8')
      : '';
    for (const text of [recorded, result.stdout, result.stderr])
      assert.equal(text.includes(credential), false);
    return inspect(
      result,
      recorded
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  });
}

test('provider failures retain safe status metadata but never credential-bearing exception details', async () =>
  runFixture(
    `export async function callHybridAIProvider() { const error = new Error('Authorization: Bearer ${credential}'); error.status = 429; error.cause = { code: 'ECONNRESET' }; throw error; }`,
    [],
    (result, rows) => {
      assert.equal(result.status, 1, result.stderr);
      const episode = rows.at(-1);
      assert.match(episode.error, /details omitted/);
      assert.equal(episode.failurePhase, 'compare');
      assert.deepEqual(episode.failure, {
        kind: 'provider-request',
        httpStatus: 429,
        transportCode: 'ECONNRESET',
      });
      assert.deepEqual(episode.trace, []);
    },
  ));

test('an invalid model judge cannot erase completed action evidence or deterministic checks', async () =>
  runFixture(
    "export async function callHybridAIProvider() { return { choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }] }; }",
    ['--judge'],
    (result, rows) => {
      assert.equal(result.status, 1, result.stderr);
      const episode = rows.at(-1);
      assert.equal(episode.error, undefined);
      assert.equal(episode.judgeError.kind, 'judge-invalid');
      assert.equal(episode.phases.length, 4);
      assert.ok(episode.checks.length > 0);
    },
  ));

test('truncated inference is recorded as incomplete rather than a successful episode', async () =>
  runFixture(
    "export async function callHybridAIProvider() { return { choices: [{ message: { content: 'partial answer' }, finish_reason: 'length' }] }; }",
    [],
    (result, rows) => {
      assert.equal(result.status, 1, result.stderr);
      assert.equal(rows.at(-1).failure.kind, 'token-limit');
      assert.equal(rows.at(-1).checks, undefined);
    },
  ));
