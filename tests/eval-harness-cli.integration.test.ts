import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HARNESS_CLI = path.join(ROOT, 'eval-harness', 'src', 'cli.ts');
// Port 9 (discard) refuses connections, so nothing here reaches a gateway.
const GATEWAY_URL = 'http://127.0.0.1:9';

const makeTempDir = useTempDir('hybridclaw-eval-cli-');

async function evalCli(
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [TSX_CLI, HARNESS_CLI, ...args],
      { cwd: ROOT, env, timeout: 60_000 },
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

describe('npm run eval -- <managed suite>', () => {
  // The runtime config is loaded lazily on this path; the run must still see
  // the configured gateway and default model, and the detached runner that
  // re-enters the CLI must finish.
  test('runs the offline trace-judge suite with the configured runtime', async () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    const home = path.join(dir, 'home');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        ops: {
          gatewayBaseUrl: GATEWAY_URL,
          gatewayInternalBaseUrl: GATEWAY_URL,
        },
        hybridai: { baseUrl: GATEWAY_URL, defaultModel: 'gpt-5' },
      }),
    );
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      HYBRIDCLAW_DATA_DIR: dataDir,
      HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
    };

    const started = await evalCli(env, ['trace-judge', 'run']);
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain(`Base URL: ${GATEWAY_URL}/v1`);
    expect(started.stdout).toContain('Base model: gpt-5');
    const runDir = /^Run dir: (.+)$/m.exec(started.stdout)?.[1] ?? '';
    expect(runDir.startsWith(dataDir)).toBe(true);

    const resultPath = path.join(runDir, 'trace-judge', 'result.json');
    await expect
      .poll(() => fs.existsSync(resultPath), { timeout: 45_000, interval: 250 })
      .toBe(true);
    const results = await evalCli(env, ['trace-judge', 'results']);
    expect(results.code, results.stderr).toBe(0);
    expect(results.stdout).toMatch(/Correct\s+(\d+)\/\1/);
  }, 90_000);
});
