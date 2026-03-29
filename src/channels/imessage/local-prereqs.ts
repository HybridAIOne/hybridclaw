import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IMESSAGE_CLI_CHECK_TIMEOUT_MS = 3_000;

export function formatMissingIMessageCliMessage(cliPath: string): string {
  const normalizedPath = String(cliPath || '').trim() || 'imsg';
  const installHint =
    normalizedPath === 'imsg'
      ? 'Install it with `brew install steipete/tap/imsg` or rerun `hybridclaw channels imessage setup --cli-path /absolute/path/to/imsg ...`.'
      : 'Check `imessage.cliPath` or rerun `hybridclaw channels imessage setup --cli-path /absolute/path/to/imsg ...`.';
  return `Missing iMessage CLI binary: ${normalizedPath}. ${installHint}`;
}

export async function assertLocalIMessageBackendReady(
  cliPath: string,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The local iMessage backend is only supported on macOS.');
  }

  try {
    await execFileAsync(cliPath, ['--help'], {
      encoding: 'utf8',
      timeout: IMESSAGE_CLI_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code || '')
        : '';
    if (code === 'ENOENT' || code === 'EACCES') {
      throw new Error(formatMissingIMessageCliMessage(cliPath));
    }
    throw error;
  }
}
