/** Benchmark subprocesses remain cancellable while resource monitoring runs. */
import { execFile } from 'node:child_process';

export async function benchmarkCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  timeout?: number;
  allowFailure?: boolean;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      params.command,
      params.args,
      {
        cwd: params.cwd,
        encoding: 'utf8',
        signal: params.signal,
        timeout: params.timeout,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && !params.allowFailure) {
          reject(error);
          return;
        }
        resolve({
          status: error
            ? typeof error.code === 'number'
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.on('error', () => {
      // An early process exit is reported by the execFile callback.
    });
    child.stdin?.end(params.input);
  });
}
