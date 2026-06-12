import { spawn } from 'node:child_process';

function getOpenCommand(url: string): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  if (process.platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (process.platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  return null;
}

/** Open a URL in the default browser. Returns false when no opener exists. */
export async function tryOpenUrlInBrowser(url: string): Promise<boolean> {
  const openCommand = getOpenCommand(url);
  if (!openCommand) return false;

  return new Promise((resolve) => {
    const child = spawn(openCommand.cmd, openCommand.args, {
      stdio: 'ignore',
      detached: true,
    });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
