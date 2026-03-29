import { spawnSync } from 'node:child_process';

export function formatMissingIMessageCliMessage(cliPath: string): string {
  const normalizedPath = String(cliPath || '').trim() || 'imsg';
  const installHint =
    normalizedPath === 'imsg'
      ? 'Install it with `brew install steipete/tap/imsg` or rerun `hybridclaw channels imessage setup --cli-path /absolute/path/to/imsg ...`.'
      : 'Check `imessage.cliPath` or rerun `hybridclaw channels imessage setup --cli-path /absolute/path/to/imsg ...`.';
  return `Missing iMessage CLI binary: ${normalizedPath}. ${installHint}`;
}

export function assertLocalIMessageBackendReady(cliPath: string): void {
  if (process.platform !== 'darwin') {
    throw new Error('The local iMessage backend is only supported on macOS.');
  }

  const result = spawnSync(cliPath, ['--help'], {
    encoding: 'utf8',
  });
  if (!result.error) return;

  if (
    (result.error as NodeJS.ErrnoException).code === 'ENOENT' ||
    (result.error as NodeJS.ErrnoException).code === 'EACCES'
  ) {
    throw new Error(formatMissingIMessageCliMessage(cliPath));
  }

  throw result.error;
}
