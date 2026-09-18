/**
 * Tailscale CLI execution preserves explicit commands and prefers PATH discovery.
 * Only a missing default command on macOS selects the installed app's CLI.
 * Unlike the tunnel provider, this module does not manage Funnel or login state;
 * it never invokes a shell or expands shell aliases.
 */
import { execFile } from 'node:child_process';

export type TailscaleCommandResult = {
  stdout: string;
  stderr: string;
};
type TailscaleCommandOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};
export type TailscaleCommandRunner = (
  args: string[],
  options?: TailscaleCommandOptions,
) => Promise<TailscaleCommandResult>;

function runTailscaleCommand(
  command: string,
  args: string[],
  options: TailscaleCommandOptions,
): Promise<TailscaleCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(
            Object.assign(new Error(detail), {
              code: (error as NodeJS.ErrnoException).code,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function createTailscaleCommandRunner(
  command: string | undefined,
  timeoutMs: number,
): TailscaleCommandRunner {
  return async (args, options) => {
    const commandOptions = {
      ...options,
      timeoutMs: options?.timeoutMs ?? timeoutMs,
    };
    try {
      return await runTailscaleCommand(
        command ?? 'tailscale',
        args,
        commandOptions,
      );
    } catch (error) {
      if (
        command !== undefined ||
        process.platform !== 'darwin' ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw error;
      }
      return runTailscaleCommand(
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        args,
        {
          ...commandOptions,
          env: { ...options?.env, TAILSCALE_BE_CLI: '1' },
        },
      );
    }
  };
}
