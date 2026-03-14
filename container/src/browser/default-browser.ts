import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserCandidate, BrowserChannel } from './types.js';

type BundleMapping = {
  channel: BrowserChannel;
  engine: BrowserCandidate['engine'];
  name: string;
  executablePath: string | null;
  userDataDir: string | null;
};

function existingPath(candidate: string | null): string | null {
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

function buildMacMappings(): Record<string, BundleMapping> {
  const home = os.homedir();
  return {
    'com.apple.safari': {
      channel: 'safari',
      engine: 'webkit',
      name: 'Safari',
      executablePath: existingPath('/Applications/Safari.app/Contents/MacOS/Safari'),
      userDataDir: path.join(home, 'Library', 'Safari'),
    },
    'com.google.chrome': {
      channel: 'chrome',
      engine: 'chromium',
      name: 'Google Chrome',
      executablePath: existingPath(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ),
      userDataDir: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    },
    'com.microsoft.edgemac': {
      channel: 'edge',
      engine: 'chromium',
      name: 'Microsoft Edge',
      executablePath: existingPath(
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ),
      userDataDir: path.join(
        home,
        'Library',
        'Application Support',
        'Microsoft Edge',
      ),
    },
    'org.chromium.chromium': {
      channel: 'chromium',
      engine: 'chromium',
      name: 'Chromium',
      executablePath: existingPath(
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ),
      userDataDir: path.join(home, 'Library', 'Application Support', 'Chromium'),
    },
  };
}

function toCandidate(
  mapping: BundleMapping,
  source: BrowserCandidate['source'],
  options: { defaultBrowser?: boolean; warning?: string } = {},
): BrowserCandidate {
  return {
    channel: mapping.channel,
    engine: mapping.engine,
    name: mapping.name,
    executablePath: mapping.executablePath,
    userDataDir: mapping.userDataDir,
    source,
    defaultBrowser: options.defaultBrowser,
    warning: options.warning,
  };
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function detectMacDefaultBrowser(): BrowserCandidate | null {
  const plistPath = path.join(
    os.homedir(),
    'Library',
    'Preferences',
    'com.apple.LaunchServices',
    'com.apple.launchservices.secure.plist',
  );
  if (!fs.existsSync(plistPath)) return null;

  const raw = runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath]);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { LSHandlers?: unknown };
    const handlers = Array.isArray(parsed.LSHandlers) ? parsed.LSHandlers : [];
    const handler = handlers.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Record<string, unknown>;
      return (
        record.LSHandlerURLScheme === 'https' ||
        record.LSHandlerURLScheme === 'http'
      );
    }) as Record<string, unknown> | undefined;
    const bundleId =
      typeof handler?.LSHandlerRoleAll === 'string'
        ? handler.LSHandlerRoleAll
        : typeof handler?.LSHandlerRoleViewer === 'string'
          ? handler.LSHandlerRoleViewer
          : '';
    const mapping = buildMacMappings()[bundleId];
    return mapping ? toCandidate(mapping, 'default', { defaultBrowser: true }) : null;
  } catch {
    return null;
  }
}

function detectWindowsDefaultBrowser(): BrowserCandidate | null {
  const progId = runCommand('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId',
  ]);
  const lower = progId.toLowerCase();
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles =
    process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (lower.includes('chromehtml')) {
    return {
      channel: 'chrome',
      engine: 'chromium',
      name: 'Google Chrome',
      executablePath:
        existingPath(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')) ||
        existingPath(
          path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ),
      userDataDir: localAppData
        ? path.join(localAppData, 'Google', 'Chrome', 'User Data')
        : null,
      source: 'default',
      defaultBrowser: true,
    };
  }
  if (lower.includes('mse')) {
    return {
      channel: 'edge',
      engine: 'chromium',
      name: 'Microsoft Edge',
      executablePath:
        existingPath(
          path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ) ||
        existingPath(
          path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ),
      userDataDir: localAppData
        ? path.join(localAppData, 'Microsoft', 'Edge', 'User Data')
        : null,
      source: 'default',
      defaultBrowser: true,
    };
  }
  return null;
}

function detectLinuxDefaultBrowser(): BrowserCandidate | null {
  const desktopEntry = runCommand('xdg-mime', [
    'query',
    'default',
    'x-scheme-handler/http',
  ]);
  const lower = desktopEntry.toLowerCase();
  if (lower.includes('google-chrome')) {
    return {
      channel: 'chrome',
      engine: 'chromium',
      name: 'Google Chrome',
      executablePath: existingPath(runCommand('which', ['google-chrome']) || null),
      userDataDir: path.join(os.homedir(), '.config', 'google-chrome'),
      source: 'default',
      defaultBrowser: true,
    };
  }
  if (lower.includes('microsoft-edge')) {
    return {
      channel: 'edge',
      engine: 'chromium',
      name: 'Microsoft Edge',
      executablePath: existingPath(runCommand('which', ['microsoft-edge']) || null),
      userDataDir: path.join(os.homedir(), '.config', 'microsoft-edge'),
      source: 'default',
      defaultBrowser: true,
    };
  }
  if (lower.includes('chromium')) {
    return {
      channel: 'chromium',
      engine: 'chromium',
      name: 'Chromium',
      executablePath:
        existingPath(runCommand('which', ['chromium']) || null) ||
        existingPath(runCommand('which', ['chromium-browser']) || null),
      userDataDir: path.join(os.homedir(), '.config', 'chromium'),
      source: 'default',
      defaultBrowser: true,
    };
  }
  if (lower.includes('safari')) {
    return {
      channel: 'safari',
      engine: 'webkit',
      name: 'Safari',
      executablePath: null,
      userDataDir: null,
      source: 'default',
      defaultBrowser: true,
    };
  }
  return null;
}

export function detectDefaultBrowser(): BrowserCandidate | null {
  if (process.platform === 'darwin') return detectMacDefaultBrowser();
  if (process.platform === 'win32') return detectWindowsDefaultBrowser();
  return detectLinuxDefaultBrowser();
}

export function findInstalledChromiumBrowsers(): BrowserCandidate[] {
  const home = os.homedir();
  const candidates: BrowserCandidate[] = [];

  const add = (candidate: BrowserCandidate | null | undefined) => {
    if (!candidate || !candidate.executablePath) return;
    if (!fs.existsSync(candidate.executablePath)) return;
    if (
      candidates.some(
        (entry) => entry.executablePath === candidate.executablePath,
      )
    ) {
      return;
    }
    candidates.push(candidate);
  };

  if (process.platform === 'darwin') {
    const mappings = buildMacMappings();
    add(toCandidate(mappings['com.google.chrome'], 'installed'));
    add(toCandidate(mappings['com.microsoft.edgemac'], 'installed'));
    add(toCandidate(mappings['org.chromium.chromium'], 'installed'));
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles =
      process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 =
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    add({
      channel: 'chrome',
      engine: 'chromium',
      name: 'Google Chrome',
      executablePath:
        existingPath(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')) ||
        existingPath(
          path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ),
      userDataDir: localAppData
        ? path.join(localAppData, 'Google', 'Chrome', 'User Data')
        : null,
      source: 'installed',
    });
    add({
      channel: 'edge',
      engine: 'chromium',
      name: 'Microsoft Edge',
      executablePath:
        existingPath(
          path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ) ||
        existingPath(
          path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ),
      userDataDir: localAppData
        ? path.join(localAppData, 'Microsoft', 'Edge', 'User Data')
        : null,
      source: 'installed',
    });
  } else {
    add({
      channel: 'chrome',
      engine: 'chromium',
      name: 'Google Chrome',
      executablePath: existingPath(runCommand('which', ['google-chrome']) || null),
      userDataDir: path.join(home, '.config', 'google-chrome'),
      source: 'installed',
    });
    add({
      channel: 'edge',
      engine: 'chromium',
      name: 'Microsoft Edge',
      executablePath: existingPath(runCommand('which', ['microsoft-edge']) || null),
      userDataDir: path.join(home, '.config', 'microsoft-edge'),
      source: 'installed',
    });
    add({
      channel: 'chromium',
      engine: 'chromium',
      name: 'Chromium',
      executablePath:
        existingPath(runCommand('which', ['chromium']) || null) ||
        existingPath(runCommand('which', ['chromium-browser']) || null),
      userDataDir: path.join(home, '.config', 'chromium'),
      source: 'installed',
    });
  }

  return candidates;
}

export function chooseChromiumBrowser(
  preferredBrowser?: BrowserChannel | 'default',
): BrowserCandidate | null {
  const defaultBrowser = detectDefaultBrowser();
  const installed = findInstalledChromiumBrowsers();

  if (preferredBrowser && preferredBrowser !== 'default') {
    const match =
      installed.find((browser) => browser.channel === preferredBrowser) ||
      (defaultBrowser?.channel === preferredBrowser ? defaultBrowser : null);
    if (match) return match;
  }

  if (defaultBrowser?.engine === 'chromium' && defaultBrowser.executablePath) {
    return defaultBrowser;
  }
  if (defaultBrowser?.channel === 'safari') {
    const fallback = installed[0];
    if (!fallback) return null;
    return {
      ...fallback,
      warning:
        'Safari does not expose CDP. Falling back to a Chromium browser for automation.',
    };
  }
  return installed[0] || null;
}
