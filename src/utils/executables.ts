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
  const currentPathExt =
    process.platform === 'win32' ? process.env.PATHEXT || '' : '';
  return {
    key: `cmd:${command}\0${currentPath}\0${currentPathExt}`,
  };
}

function readShebangInterpreter(candidate: string): string | null {
  if (process.platform === 'win32') return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(candidate, 'r');
    const buffer = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/u)[0];
    if (!firstLine?.startsWith('#!')) return null;
    const interpreter = firstLine.slice(2).trim().split(/\s+/u)[0];
    return interpreter ? interpreter.trim() : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failures while probing executables
      }
    }
  }
}

function hasUsableExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    return false;
  }

  const interpreter = readShebangInterpreter(candidate);
  if (!interpreter || !path.isAbsolute(interpreter)) {
    return true;
  }

  try {
    fs.accessSync(interpreter, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
    if (hasUsableExecutableFile(candidate)) {
      executablePresenceCache.set(key, true);
      return true;
    }
    return false;
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
      if (hasUsableExecutableFile(candidate)) {
        executablePresenceCache.set(key, true);
        return true;
      }
    }
  }

  return false;
}
