import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolveInstallRoot } from '../../infra/install-root.js';
import type { DiagResult } from '../types.js';
import { makeResult, shortenHomePath } from '../utils.js';

const require = createRequire(import.meta.url);

export type BrowserUsePlaywrightModule = {
  chromium: {
    executablePath(): string;
  };
};

function runPlaywrightInstall(): Promise<void> {
  return new Promise((resolve, reject) => {
    let cliPath: string;
    try {
      cliPath = new URL(
        'cli.js',
        `file://${require.resolve('playwright/package.json')}`,
      ).pathname;
    } catch (error) {
      reject(
        new Error(
          `Playwright package is not installed; run npm install first. Cause: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return;
    }

    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      cwd: resolveInstallRoot(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Playwright Chromium install was interrupted by ${signal}`
            : `Playwright Chromium install exited with code ${code}`,
        ),
      );
    });
  });
}

export function buildBrowserUseResults(
  playwright: BrowserUsePlaywrightModule,
): DiagResult[] {
  const chromiumPath = playwright.chromium.executablePath();
  if (fs.existsSync(chromiumPath)) {
    return [
      makeResult(
        'browser-use',
        'Browser use',
        'ok',
        `Playwright Chromium installed at ${shortenHomePath(chromiumPath)}`,
      ),
    ];
  }

  return [
    makeResult(
      'browser-use',
      'Browser use',
      'warn',
      `Playwright Chromium is not installed at ${shortenHomePath(chromiumPath)}`,
      {
        summary: 'Install Playwright Chromium (~300 MB)',
        apply: runPlaywrightInstall,
      },
    ),
  ];
}

export async function checkBrowserUse(): Promise<DiagResult[]> {
  let playwright: BrowserUsePlaywrightModule;
  try {
    playwright = (await import('playwright')) as BrowserUsePlaywrightModule;
  } catch (error) {
    return [
      makeResult(
        'browser-use',
        'Browser use',
        'error',
        `Playwright package unavailable; run npm install. Cause: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    ];
  }

  return buildBrowserUseResults(playwright);
}
