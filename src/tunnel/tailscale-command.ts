/**
 * Tailscale CLI execution preserves explicit commands and PATH-first discovery.
 * A working macOS app CLI is reused until its executable disappears.
 * Unlike the tunnel provider, this module does not manage Funnel or login state;
 * it never invokes a shell or expands shell aliases.
 */
import { execFile } from 'node:child_process';

const MACOS_TAILSCALE_COMMAND =
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

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
  let useMacOsApp = false;
  return async (args, options) => {
    const commandOptions = {
      ...options,
      timeoutMs: options?.timeoutMs ?? timeoutMs,
    };
    const appCommandOptions = {
      ...commandOptions,
      env: { ...options?.env, TAILSCALE_BE_CLI: '1' },
    };
    if (useMacOsApp) {
      try {
        return await runTailscaleCommand(
          MACOS_TAILSCALE_COMMAND,
          args,
          appCommandOptions,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        useMacOsApp = false;
      }
    }
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
      const result = await runTailscaleCommand(
        MACOS_TAILSCALE_COMMAND,
        args,
        appCommandOptions,
      );
      useMacOsApp = true;
      return result;
    }
  };
}
