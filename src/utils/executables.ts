import fs from 'node:fs';
import path from 'node:path';

const executablePresenceCache = new Map<string, true>();

function buildExecutableCacheKey(
  command: string,
  options?: {
    cwd?: string;
  },
): { key: string; candidate?: string } {
  const cwd = options?.cwd || process.cwd();
  const isPathLike =
    path.isAbsolute(command) || command.includes('/') || command.includes('\\');

  if (isPathLike) {
    const candidate = path.isAbsolute(command)
      ? command
      : path.resolve(cwd, command);
    return {
      key: `path:${candidate}`,
      candidate,
    };
  }

  const currentPath = process.env.PATH || '';
  const currentPathExt = process.platform === 'win32' ? process.env.PATHEXT || '' : '';
  return {
    key: `cmd:${command}\0${currentPath}\0${currentPathExt}`,
  };
}

export function hasExecutableCommand(
  command: string,
  options?: {
    cwd?: string;
  },
): boolean {
  const normalized = String(command || '').trim();
  if (!normalized) return false;

  const { key, candidate } = buildExecutableCacheKey(normalized, options);
  if (executablePresenceCache.has(key)) {
    return true;
  }

  const isPathLike = candidate !== undefined;
  if (isPathLike) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      executablePresenceCache.set(key, true);
      return true;
    } catch {
      return false;
    }
  }

  const currentPath = process.env.PATH || '';
  const currentPathExt =
    process.platform === 'win32' ? process.env.PATHEXT || '' : '';

  const exts =
    process.platform === 'win32'
      ? [
          '',
          ...currentPathExt
            .split(';')
            .map((ext) => ext.trim())
            .filter(Boolean),
        ]
      : [''];
  for (const part of currentPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(part, `${normalized}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        executablePresenceCache.set(key, true);
        return true;
      } catch {
        // continue scanning
      }
    }
  }

  return false;
}
