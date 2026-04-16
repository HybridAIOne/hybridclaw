import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { resolveInstallPath } from '../infra/install-root.js';

/**
 * Serves the Docusaurus static build output for /docs and /development routes.
 *
 * In development the build directory may not exist yet; in that case the
 * function returns false so the gateway can fall through to other handlers.
 */

export const DOCS_ROUTE = '/docs';

const DOCUSAURUS_BUILD_DIR = resolveInstallPath('website', 'build');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function sendFile(filePath: string, res: ServerResponse): void {
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'Content-Length': content.byteLength,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(content);
}

function resolveStaticFile(
  pathname: string,
): string | null {
  if (!fs.existsSync(DOCUSAURUS_BUILD_DIR)) return null;

  // Normalise and prevent directory traversal
  const normalized = path
    .normalize(pathname)
    .replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.resolve(DOCUSAURUS_BUILD_DIR, `.${normalized}`);
  if (!candidate.startsWith(DOCUSAURUS_BUILD_DIR)) return null;

  // Exact file match
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // Try appending index.html for directory-style URLs
  const indexCandidate = path.join(candidate, 'index.html');
  if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) {
    return indexCandidate;
  }

  // Try appending .html (Docusaurus trailingSlash: false)
  const htmlCandidate = `${candidate}.html`;
  if (fs.existsSync(htmlCandidate) && fs.statSync(htmlCandidate).isFile()) {
    return htmlCandidate;
  }

  return null;
}

const RECOGNIZED_PREFIXES = ['/docs', '/development', '/assets/', '/search'];

export function serveDocs(url: URL, res: ServerResponse): boolean {
  const pathname = url.pathname;

  // Only handle docs-related routes and Docusaurus asset routes
  const isDocsRoute = RECOGNIZED_PREFIXES.some((p) =>
    pathname === p || pathname.startsWith(`${p}/`),
  );

  // Also serve the root landing page from Docusaurus
  const isRootRoute = pathname === '/' || pathname === '/index.html';

  if (!isDocsRoute && !isRootRoute) return false;

  const file = resolveStaticFile(pathname);
  if (file) {
    sendFile(file, res);
    return true;
  }

  // For SPA-style routes without a matching file, serve the Docusaurus 404 page
  // so client-side routing can take over
  const fallback = resolveStaticFile('/404.html');
  if (fallback) {
    const content = fs.readFileSync(fallback);
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.byteLength,
    });
    res.end(content);
    return true;
  }

  return false;
}
