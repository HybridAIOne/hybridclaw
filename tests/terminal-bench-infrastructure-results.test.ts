import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { handleEvalCommand } from '../eval-harness/src/eval-command.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();

test('does not publish a task score for an infrastructure-interrupted benchmark', async () => {
  const dataDir = tempDir();
  const runDir = path.join(dataDir, 'evals', 'eval-infrastructure-run');
  const jobDir = path.join(dataDir, 'jobs', 'example');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(jobDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  fs.writeFileSync(stdoutPath, `Job dir: ${jobDir}\nTasks: 2\n`);
  fs.writeFileSync(stderrPath, 'Benchmark infrastructure stopped: engine disk pressure\n');
  fs.writeFileSync(path.join(jobDir, 'result.json'), JSON.stringify({
    trials: 2, mean: 0, errors: 2, rewards: [], infrastructureError: 'engine disk pressure',
  }));
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    runId: 'eval-infrastructure-run', suiteId: 'terminal-bench-2.0', operation: 'run',
    pid: null, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z',
    exitCode: 1, cwd: dataDir, command: 'terminal-bench-2.0 run',
    stdoutPath, stderrPath, model: 'example-model', baseModel: 'example-model',
  }));
  const result = await handleEvalCommand({
    args: ['terminal-bench-2.0', 'results'], dataDir,
    gatewayBaseUrl: 'http://127.0.0.1:9090', webApiToken: '', gatewayApiToken: 'test-key',
    effectiveAgentId: 'main', effectiveModel: 'example-model',
  });
  expect(result.text).toMatch(/Status\s+failed/);
  expect(result.text).not.toMatch(/Score\s+[\d.]+/);
});
