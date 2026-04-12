import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .trim();
}

function sanitizePathSegment(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function buildTurnId(messages) {
  const timestampValue = String(messages.at(-1)?.created_at || '').trim();
  const timestamp = Number.isFinite(Date.parse(timestampValue))
    ? new Date(timestampValue).toISOString().replace(/[:.]/g, '-')
    : new Date().toISOString().replace(/[:.]/g, '-');
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        messages.map((message) => ({
          role: message.role,
          content: message.content,
          created_at: message.created_at,
        })),
      ),
    )
    .digest('hex')
    .slice(0, 12);
  return `${timestamp}-${hash}`;
}

function formatTranscriptBlock(message) {
  const role = String(message?.role || '')
    .trim()
    .toLowerCase();
  const content = normalizeText(message?.content);
  if (!content) return '';

  if (role === 'user') {
    return content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }

  if (role === 'assistant') {
    return content;
  }

  return [`[${role || 'message'}]`, content].join('\n');
}

export function buildTurnExportText(params) {
  return params.messages
    .map((message) => formatTranscriptBlock(message))
    .filter(Boolean)
    .join('\n\n')
    .trim()
    .concat('\n');
}

export async function writeTurnExport(params) {
  const sessionDir = path.join(
    params.exportDir,
    sanitizePathSegment(params.sessionId, 'session'),
  );
  const turnId = buildTurnId(params.messages);
  const turnDir = path.join(sessionDir, turnId);
  const filePath = path.join(turnDir, 'conversation.md');
  await fs.mkdir(turnDir, { recursive: true });
  await fs.writeFile(filePath, buildTurnExportText(params), 'utf-8');
  return {
    filePath,
    turnDir,
  };
}
