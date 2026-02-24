/**
 * Workspace bootstrap files — loads SOUL.md, IDENTITY.md, USER.md,
 * TOOLS.md, MEMORY.md, HEARTBEAT.md from the agent workspace
 * and injects them into the system prompt (like OpenClaw).
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { agentWorkspaceDir } from './ipc.js';

const BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'BOOT.md',
] as const;

const MAX_FILE_CHARS = 20_000;
const TEMPLATES_DIR = path.join(process.cwd(), 'templates');

export interface ContextFile {
  name: string;
  content: string;
}

/**
 * Ensure workspace has bootstrap files, copying from templates if missing.
 */
export function ensureBootstrapFiles(agentId: string): void {
  const wsDir = agentWorkspaceDir(agentId);
  fs.mkdirSync(wsDir, { recursive: true });

  for (const filename of BOOTSTRAP_FILES) {
    const destPath = path.join(wsDir, filename);
    if (fs.existsSync(destPath)) continue;

    const templatePath = path.join(TEMPLATES_DIR, filename);
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, destPath);
      logger.debug({ agentId, file: filename }, 'Copied bootstrap template');
    }
  }
}

/**
 * Load all bootstrap files from the workspace.
 * Returns only files that exist and have content.
 */
export function loadBootstrapFiles(agentId: string): ContextFile[] {
  const wsDir = agentWorkspaceDir(agentId);
  const files: ContextFile[] = [];

  for (const filename of BOOTSTRAP_FILES) {
    const filePath = path.join(wsDir, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      let content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + '\n\n[truncated]';
      }

      files.push({ name: filename, content });
    } catch (err) {
      logger.warn({ agentId, file: filename, err }, 'Failed to read bootstrap file');
    }
  }

  return files;
}

/**
 * Format the current date/time in a human-friendly way, like OpenClaw.
 * e.g. "Tuesday, February 24th, 2026 — 14:32"
 */
function formatCurrentTime(timezone?: string): string {
  const tz = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    if (!map.weekday || !map.year || !map.month || !map.day || !map.hour || !map.minute) {
      return now.toISOString();
    }
    const dayNum = parseInt(map.day, 10);
    const suffix = dayNum >= 11 && dayNum <= 13 ? 'th'
      : dayNum % 10 === 1 ? 'st'
      : dayNum % 10 === 2 ? 'nd'
      : dayNum % 10 === 3 ? 'rd' : 'th';
    return `${map.weekday}, ${map.month} ${dayNum}${suffix}, ${map.year} — ${map.hour}:${map.minute} (${tz})`;
  } catch {
    return now.toISOString();
  }
}

/**
 * Build a system prompt section from loaded context files.
 * Injects current date/time (like OpenClaw) so the agent knows when "now" is.
 */
export function buildContextPrompt(files: ContextFile[]): string {
  if (files.length === 0) return '';

  // Extract timezone from USER.md if available
  const userFile = files.find((f) => f.name === 'USER.md');
  const tzMatch = userFile?.content.match(/\*\*Timezone:\*\*\s*(.+)/i);
  const userTimezone = tzMatch?.[1]?.trim() || undefined;

  const lines: string[] = [
    '# Project Context',
    '',
    'The following workspace context files have been loaded.',
    'If SOUL.md is present, embody its persona and tone.',
    '',
    '## Current Date & Time',
    formatCurrentTime(userTimezone),
    '',
  ];

  for (const file of files) {
    lines.push(`## ${file.name}`, '', file.content, '');
  }

  return lines.join('\n');
}

/**
 * Check if the workspace still needs bootstrapping.
 * Like OpenClaw: if the agent deleted BOOTSTRAP.md, or if IDENTITY.md / USER.md
 * have been modified from templates, bootstrapping is considered complete.
 */
export function isBootstrapping(agentId: string): boolean {
  const wsDir = agentWorkspaceDir(agentId);
  if (!fs.existsSync(path.join(wsDir, 'BOOTSTRAP.md'))) return false;

  // Fallback: if the agent already filled in IDENTITY.md or USER.md, it's done
  for (const filename of ['IDENTITY.md', 'USER.md']) {
    const wsFile = path.join(wsDir, filename);
    const tmplFile = path.join(TEMPLATES_DIR, filename);
    if (!fs.existsSync(wsFile) || !fs.existsSync(tmplFile)) continue;
    const wsContent = fs.readFileSync(wsFile, 'utf-8');
    const tmplContent = fs.readFileSync(tmplFile, 'utf-8');
    if (wsContent !== tmplContent) {
      // Agent modified workspace files — bootstrapping is effectively done, clean up
      fs.unlinkSync(path.join(wsDir, 'BOOTSTRAP.md'));
      return false;
    }
  }

  return true;
}

