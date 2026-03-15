import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import { logger } from '../logger.js';
import { hasApiAuth, sendJson } from './gateway-http-common.js';

const AGENT_ARTIFACT_ROOT = path.resolve(path.join(DATA_DIR, 'agents'));
const DISCORD_MEDIA_CACHE_DIR = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);

const SAFE_INLINE_ARTIFACT_MIME_TYPES: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolvePathForContainmentCheck(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveArtifactFile(url: URL): string | null {
  const raw = (url.searchParams.get('path') || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (
    !isWithinRoot(
      realFilePath,
      resolvePathForContainmentCheck(AGENT_ARTIFACT_ROOT),
    ) &&
    !isWithinRoot(
      realFilePath,
      resolvePathForContainmentCheck(DISCORD_MEDIA_CACHE_DIR),
    )
  ) {
    return null;
  }
  if (!fs.existsSync(realFilePath) || !fs.statSync(realFilePath).isFile()) {
    return null;
  }
  return realFilePath;
}

export function handleApiArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (!hasApiAuth(req, url, { allowQueryToken: true })) {
    sendJson(res, 401, {
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
    return;
  }

  const filePath = resolveArtifactFile(url);
  if (!filePath) {
    sendJson(res, 404, { error: 'Artifact not found.' });
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError) {
      const code = (statError as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        sendJson(res, 404, { error: 'Artifact not found.' });
        return;
      }
      logger.warn(
        { filePath, error: statError },
        'Failed to stat artifact before streaming',
      );
      sendJson(res, 500, { error: 'Failed to read artifact.' });
      return;
    }

    if (!stats.isFile()) {
      sendJson(res, 404, { error: 'Artifact not found.' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const inlineMimeType = SAFE_INLINE_ARTIFACT_MIME_TYPES[ext];
    const mimeType = inlineMimeType || 'application/octet-stream';
    const dispositionType = inlineMimeType ? 'inline' : 'attachment';
    const filename = path.basename(filePath);
    const stream = fs.createReadStream(filePath);

    stream.on('open', () => {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': `${dispositionType}; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
        'Content-Length': String(stats.size),
        'X-Content-Type-Options': 'nosniff',
        ...(dispositionType === 'attachment'
          ? {
              'Content-Security-Policy': "sandbox; default-src 'none'",
            }
          : {}),
      });
    });

    stream.on('data', (chunk) => {
      res.write(chunk);
    });

    stream.on('end', () => {
      if (!res.writableEnded) res.end();
    });

    stream.on('error', (error) => {
      logger.warn({ filePath, error }, 'Failed to stream artifact');
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Failed to read artifact.' });
        return;
      }
      if (typeof res.destroy === 'function') {
        res.destroy(error);
        return;
      }
      if (!res.writableEnded) res.end();
    });
  });
}
