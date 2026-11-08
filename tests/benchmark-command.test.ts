import { expect, test } from 'vitest';
import { benchmarkCommand } from '../eval-harness/src/benchmark-command.js';

test('keeps monitoring runnable while a benchmark subprocess runs', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks += 1, 5);
  try {
    const result = await benchmarkCommand({ command: process.execPath, args: ['-e', 'setTimeout(() => console.log("done"), 80)'] });
    expect(result.stdout.trim()).toBe('done');
    expect(ticks).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
  }
});

test('can cancel an in-flight build, extraction, copy or verifier command', async () => {
  const controller = new AbortController();
  const command = benchmarkCommand({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], signal: controller.signal });
  const rejection = expect(command).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejection;
});

test('bounds engine probes with a timeout and preserves ordinary verifier exit codes', async () => {
  await expect(benchmarkCommand({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 30 })).rejects.toMatchObject({ killed: true });
  expect(await benchmarkCommand({ command: process.execPath, args: ['-e', 'console.error("failed"); process.exitCode = 7'], allowFailure: true })).toMatchObject({ status: 7, stderr: 'failed\n' });
});
