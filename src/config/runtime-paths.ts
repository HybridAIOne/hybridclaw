import os from 'node:os';
import path from 'node:path';

export function resolveDefaultRuntimeHomeDir(): string {
  const envDir = (process.env.HYBRIDCLAW_DATA_DIR || '').trim();
  if (envDir && !path.isAbsolute(envDir)) {
    throw new Error(
      `HYBRIDCLAW_DATA_DIR must be an absolute path, got: ${envDir}`,
    );
  }
  return envDir || path.join(os.homedir(), '.hybridclaw');
}

export const DEFAULT_RUNTIME_HOME_DIR = resolveDefaultRuntimeHomeDir();
