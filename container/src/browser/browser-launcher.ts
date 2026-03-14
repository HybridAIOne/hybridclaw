import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { chooseChromiumBrowser } from './default-browser.js';
import type {
  BrowserChannel,
  BrowserExecutionMode,
  BrowserLaunchResult,
} from './types.js';

const DEVTOOLS_URL_RE = /DevTools listening on (ws:\/\/\S+)/i;
const LAUNCH_TIMEOUT_MS = 15_000;

function buildLaunchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (!value) continue;
    env[key] = value;
  }
  return env;
}

function extractPortFromWsUrl(wsUrl: string): number | undefined {
  try {
    const parsed = new URL(wsUrl);
    if (!parsed.port) return undefined;
    const port = Number.parseInt(parsed.port, 10);
    return Number.isFinite(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

async function waitForDevToolsUrl(
  child: ChildProcess,
): Promise<{ wsUrl: string; stderr: string[] }> {
  const stderrLines: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Timed out waiting for a DevTools websocket URL. If Chrome is already running without remote debugging, restart it with --remote-debugging-port or use the extension relay.',
        ),
      );
    }, LAUNCH_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      stderrLines.push(text);
      const match = text.match(DEVTOOLS_URL_RE);
      if (!match?.[1]) return;
      cleanup();
      resolve({ wsUrl: match[1], stderr: stderrLines });
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Browser exited before exposing DevTools (exit code ${code ?? 'unknown'})`,
        ),
      );
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function launchBrowserWithCdp(options: {
  executionMode: BrowserExecutionMode;
  headed?: boolean;
  preferredBrowser?: BrowserChannel | 'default';
}): Promise<BrowserLaunchResult> {
  if (options.executionMode !== 'host') {
    throw new Error(
      'Launching a desktop browser is only supported in host sandbox mode. In container mode, use an existing CDP endpoint or the extension relay.',
    );
  }

  const browser = chooseChromiumBrowser(options.preferredBrowser);
  if (!browser?.executablePath) {
    throw new Error(
      'No Chromium browser was found. Install Chrome, Edge, or Chromium, or expose an existing CDP endpoint.',
    );
  }

  const args = [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
  ];
  if (browser.userDataDir) args.push(`--user-data-dir=${browser.userDataDir}`);
  if (options.headed === false) args.push('--headless=new');

  const child = spawn(browser.executablePath, args, {
    env: buildLaunchEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  try {
    const { wsUrl } = await waitForDevToolsUrl(child);
    return {
      browser,
      mode: 'agent-launched',
      wsUrl,
      port: extractPortFromWsUrl(wsUrl),
      process: child,
    };
  } catch (error) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}
