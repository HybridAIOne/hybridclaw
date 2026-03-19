import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeWhitespace(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function quoteYaml(value) {
  return JSON.stringify(String(value || ''));
}

function sanitizeSessionId(sessionId) {
  const normalized = String(sessionId || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'session';
}

function formatMessageSection(message, index) {
  const role = normalizeWhitespace(message.role) || 'unknown';
  const createdAt = normalizeWhitespace(message.created_at) || 'unknown-time';
  const username = normalizeWhitespace(message.username);
  const heading = username
    ? `## ${index + 1}. ${role} (${username}) · ${createdAt}`
    : `## ${index + 1}. ${role} · ${createdAt}`;
  const content = normalizeWhitespace(message.content) || '_Empty message_';
  return [heading, '', content].join('\n');
}

export function buildSessionExportMarkdown(params) {
  const exportedAt = new Date().toISOString();
  const frontmatter = [
    '---',
    `sessionId: ${quoteYaml(params.sessionId)}`,
    `userId: ${quoteYaml(params.userId)}`,
    `agentId: ${quoteYaml(params.agentId)}`,
    `exportedAt: ${quoteYaml(exportedAt)}`,
    `messageCount: ${params.messages.length}`,
    '---',
  ].join('\n');

  const summary = [
    `# HybridClaw Session ${params.sessionId}`,
    '',
    `- User: ${params.userId}`,
    `- Agent: ${params.agentId}`,
    `- Exported at: ${exportedAt}`,
    `- Message count: ${params.messages.length}`,
    '',
    '## Transcript',
    '',
  ].join('\n');

  const transcript = params.messages
    .map((message, index) => formatMessageSection(message, index))
    .join('\n\n');

  return `${frontmatter}\n\n${summary}${transcript}\n`;
}

export async function writeSessionExport(params) {
  await fs.mkdir(params.exportDir, { recursive: true });
  const filePath = path.join(
    params.exportDir,
    `${sanitizeSessionId(params.sessionId)}.md`,
  );
  const markdown = buildSessionExportMarkdown(params);
  await fs.writeFile(filePath, markdown, 'utf-8');
  return filePath;
}
