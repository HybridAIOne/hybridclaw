import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, vi } from 'vitest';

interface GatewayTestSetupOptions {
  tempHomePrefix: string;
  envVars?: string[];
  cleanup?: () => void | Promise<void>;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export function setupGatewayTest(options: GatewayTestSetupOptions): {
  setupHome: (extraEnv?: Record<string, string>) => string;
} {
  const trackedEnvVars = Array.from(
    new Set([
      'HOME',
      'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
      ...(options.envVars ?? []),
    ]),
  );
  const originalEnv = new Map(
    trackedEnvVars.map((name) => [name, process.env[name]]),
  );

  const makeTempHome = (): string =>
    fs.mkdtempSync(path.join(os.tmpdir(), options.tempHomePrefix));

  afterEach(async () => {
    await options.cleanup?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    for (const [name, value] of originalEnv) {
      restoreEnvVar(name, value);
    }
  });

  const setupHome = (extraEnv?: Record<string, string>): string => {
    const homeDir = makeTempHome();
    process.env.HOME = homeDir;
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
    for (const [name, value] of Object.entries(extraEnv ?? {})) {
      process.env[name] = value;
    }
    vi.resetModules();
    return homeDir;
  };

  return { setupHome };
}
