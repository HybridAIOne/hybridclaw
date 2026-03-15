import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

import { resolveInstallPath } from '../infra/install-root.js';

const SITE_DIR = resolveInstallPath('docs');
const CONSOLE_DIST_DIR = resolveInstallPath('console', 'dist');

const SITE_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function resolveStaticFile(rootDir: string, pathname: string): string | null {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.resolve(rootDir, `.${normalized}`);
  if (!candidate.startsWith(rootDir)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    return null;
  return candidate;
}

function resolveSiteFile(pathname: string): string | null {
  return resolveStaticFile(
    SITE_DIR,
    pathname === '/' ? '/index.html' : pathname,
  );
}

function resolveConsoleFile(pathname: string): string | null {
  const subPath = pathname.replace(/^\/admin/, '') || '/index.html';
  const directFile = resolveStaticFile(CONSOLE_DIST_DIR, subPath);
  if (directFile) return directFile;
  return resolveStaticFile(CONSOLE_DIST_DIR, '/index.html');
}

export function serveStatic(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveSiteFile(
    pathname === '/chat'
      ? '/chat.html'
      : pathname === '/agents'
        ? '/agents.html'
        : pathname,
  );
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(fs.readFileSync(filePath));
  return true;
}

export function serveConsole(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveConsoleFile(pathname);
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Cache-Control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  res.end(fs.readFileSync(filePath));
  return true;
}
