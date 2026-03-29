/**
 * Browser Login — opens a headed Chromium browser with the shared persistent
 * profile directory so the user can manually log into sites (Google, etc.).
 *
 * The logged-in session (cookies, localStorage, IndexedDB) is persisted in
 * `~/.hybridclaw/data/browser-profiles/` and automatically mounted into
 * agent containers, giving the agent access to authenticated browser sessions
 * without needing credentials in chat.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BrowserLoginOptions {
  /** URL to open when the browser starts (default: about:blank). */
  url?: string;
}

export function buildBrowserLoginArgs(
  profileDir: string,
  options: BrowserLoginOptions = {},
): string[] {
  const url = options.url || 'about:blank';
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    // Use Chromium's basic password store for this dedicated automation profile
    // so the persisted session stays readable to the automation runtime. This
    // intentionally avoids the OS keychain and should not be treated as a safe
    // default for general-purpose browsing profiles.
    '--password-store=basic',
    '--use-mock-keychain',
    url,
  ];
}

function resolvePlaywrightChromium(): string | null {
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const searchRoots = [
    envPath,
    path.join(
      process.cwd(),
      'node_modules',
      'playwright-core',
      '.local-browsers',
    ),
    path.join(process.cwd(), 'node_modules', 'playwright', '.local-browsers'),
  ].filter(Boolean) as string[];

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root);
      const chromiumDir = entries.find((e) => e.startsWith('chromium'));
      if (!chromiumDir) continue;
      const candidates = [
        path.join(root, chromiumDir, 'chrome-linux', 'chrome'),
        path.join(root, chromiumDir, 'chrome-linux', 'headless_shell'),
        path.join(root, chromiumDir, 'chrome'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

function resolveChromeBinary(): string {
  // Allow explicit override via env var
  const envBrowser = process.env.CHROME_BIN?.trim();
  if (envBrowser) return envBrowser;

  const platform = os.platform();

  // Platform-specific system browser candidates
  const systemBrowsers: string[] =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          'google-chrome',
          'google-chrome-stable',
          'chromium-browser',
          'chromium',
        ];

  for (const browser of systemBrowsers) {
    if (platform === 'darwin') {
      if (fs.existsSync(browser)) return browser;
    } else {
      const result = spawnSync('which', [browser], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout?.trim()) {
        return result.stdout.trim();
      }
    }
  }

  // Fallback to Playwright-installed Chromium
  const playwrightChromium = resolvePlaywrightChromium();
  if (playwrightChromium) return playwrightChromium;

  throw new Error(
    'No Chrome or Chromium browser found. Install google-chrome, chromium, or set CHROME_BIN.',
  );
}

export async function launchBrowserLogin(
  profileDir: string,
  options: BrowserLoginOptions = {},
): Promise<ChildProcess> {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const chromeBin = resolveChromeBinary();
  const args = buildBrowserLoginArgs(profileDir, options);

  const env = { ...process.env };
  // Only set DISPLAY fallback on Linux where X11 is expected
  if (os.platform() === 'linux' && !env.DISPLAY) {
    env.DISPLAY = ':0';
  }

  const child = spawn(chromeBin, args, {
    stdio: 'ignore',
    detached: false,
    env,
  });

  return child;
}

export function getBrowserProfileDir(dataDir: string): string {
  return path.join(dataDir, 'browser-profiles');
}
