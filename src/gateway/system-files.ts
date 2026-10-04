/**
 * Read-only operator browser of runtime home, including hidden files.
 * Unlike artifacts.read, system_files.read can expose config and credentials.
 * Confined paths, no symlinks, special files or writes; bounded pages/downloads.
 * This does not invoke an agent or a shell.
 */
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { sendJson } from './gateway-http-utils.js';

export { SYSTEM_FILES_PATH } from '../security/admin-rbac.js';

const PAGE_SIZE = 500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function resolveFile(root: string, relative: string): string {
  const parts = relative === '' ? [] : relative.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes('\0') ||
        part.includes('\\'),
    ) ||
    path.isAbsolute(relative)
  ) {
    throw new GatewayRequestError(400, 'Expected a relative runtime path.');
  }
  let target = fs.realpathSync(root);
  for (const part of parts) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new GatewayRequestError(403, 'Symbolic links cannot be opened.');
    }
  }
  return target;
}

export function listSystemFiles(
  root: string,
  relative: string,
  offset: number,
) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new GatewayRequestError(400, 'Invalid directory offset.');
  }
  const target = resolveFile(root, relative);
  if (!fs.statSync(target).isDirectory())
    throw new GatewayRequestError(400, 'Expected a folder.');
  const children = fs
    .readdirSync(target, { withFileTypes: true })
    .sort((a, b) => {
      return (
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name)
      );
    });
  const entries = children.slice(offset, offset + PAGE_SIZE).map((entry) => {
    const stats = fs.lstatSync(path.join(target, entry.name));
    const kind = stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other';
    return {
      name: entry.name,
      path: relative ? `${relative}/${entry.name}` : entry.name,
      kind,
      size: stats.isFile() ? stats.size : null,
    };
  });
  return {
    path: relative,
    entries,
    nextOffset:
      offset + PAGE_SIZE < children.length ? offset + PAGE_SIZE : null,
  };
}

export function readSystemFile(root: string, relative: string): Buffer {
  const target = resolveFile(root, relative);
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stats = fs.fstatSync(fd);
    const current = fs.statSync(resolveFile(root, relative));
    if (stats.ino !== current.ino || stats.dev !== current.dev) {
      throw new GatewayRequestError(409, 'File changed while opening.');
    }
    if (!stats.isFile())
      throw new GatewayRequestError(400, 'Expected a regular file.');
    if (stats.size > MAX_FILE_BYTES)
      throw new GatewayRequestError(413, 'File exceeds 25 MB.');
    const buffer = Buffer.alloc(Math.min(stats.size + 1, MAX_FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length > stats.size)
      throw new GatewayRequestError(409, 'File changed while reading.');
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

export function handleSystemFilesRoute(
  res: ServerResponse,
  method: string,
  url: URL,
): void {
  res.setHeader('Cache-Control', 'no-store');
  if (method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  try {
    const relative = url.searchParams.get('path') ?? '';
    if (url.searchParams.get('download') === 'true') {
      const bytes = readSystemFile(DEFAULT_RUNTIME_HOME_DIR, relative);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(bytes);
    } else {
      sendJson(
        res,
        200,
        listSystemFiles(
          DEFAULT_RUNTIME_HOME_DIR,
          relative,
          Number(url.searchParams.get('offset') ?? '0'),
        ),
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status =
      error instanceof GatewayRequestError
        ? error.statusCode
        : code === 'ENOENT'
          ? 404
          : ['EACCES', 'EPERM', 'ELOOP'].includes(code ?? '')
            ? 403
            : 500;
    sendJson(res, status, {
      error:
        error instanceof GatewayRequestError
          ? error.message
          : 'Could not read this runtime path.',
    });
  }
}
