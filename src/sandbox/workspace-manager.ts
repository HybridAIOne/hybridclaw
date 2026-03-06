/**
 * Workspace manager — manages per-agent workspaces stored in sandbox-service volumes.
 * Each agent (agentId = chatbotId) gets one named volume `ws-{agentId}`.
 * The volume is mounted at /workspace inside their sandbox.
 * Workspace files (SOUL.md, MEMORY.md, etc.) persist across sandbox recreations.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

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

/** Minimal interface for sandbox client — dependency injection. */
export interface WorkspaceClient {
  createVolume(name: string): Promise<{ volumeId: string }>;
  getOrCreateVolume(name: string): Promise<{ volumeId: string }>;
  readFile(sandboxId: string, path: string): Promise<string>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
}

export class WorkspaceManager {
  constructor(private client: WorkspaceClient) {}

  async ensureVolume(agentId: string): Promise<{ volumeId: string }> {
    return this.client.getOrCreateVolume(`ws-${agentId}`);
  }

  /**
   * Upload each template file to /workspace/ IF it doesn't already exist in sandbox.
   */
  async bootstrapWorkspace(sandboxId: string, agentId: string): Promise<void> {
    for (const filename of BOOTSTRAP_FILES) {
      const templatePath = path.join(TEMPLATES_DIR, filename);
      if (!fs.existsSync(templatePath)) continue;

      const remotePath = `/workspace/${filename}`;

      // Check if file already exists in sandbox
      try {
        await this.client.readFile(sandboxId, remotePath);
        // File exists — skip
        continue;
      } catch {
        // File doesn't exist (404) — upload it
      }

      try {
        const content = fs.readFileSync(templatePath, 'utf-8');
        await this.client.writeFile(sandboxId, remotePath, content);
        logger.debug({ agentId, file: filename }, 'Uploaded bootstrap template to sandbox');
      } catch (err) {
        logger.warn({ agentId, file: filename, err }, 'Failed to upload bootstrap template');
      }
    }
  }

  /**
   * Download workspace files from sandbox via readFile.
   * Skip missing files gracefully.
   */
  async loadWorkspaceContext(sandboxId: string, agentId: string): Promise<ContextFile[]> {
    const files: ContextFile[] = [];

    for (const filename of BOOTSTRAP_FILES) {
      const remotePath = `/workspace/${filename}`;
      try {
        let content = (await this.client.readFile(sandboxId, remotePath)).trim();
        if (!content) continue;

        if (content.length > MAX_FILE_CHARS) {
          content = content.slice(0, MAX_FILE_CHARS) + '\n\n[truncated]';
        }

        files.push({ name: filename, content });
      } catch {
        // File doesn't exist or read error — skip
      }
    }

    return files;
  }

  /**
   * Build a system prompt section from loaded context files.
   * Injects current date/time so the agent knows when "now" is.
   */
  buildContextPrompt(files: ContextFile[]): string {
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
   * If BOOTSTRAP.md doesn't exist, bootstrapping is done.
   * If IDENTITY.md or USER.md differ from templates, bootstrapping is done.
   */
  async isBootstrapping(sandboxId: string): Promise<boolean> {
    // Check if BOOTSTRAP.md exists
    try {
      await this.client.readFile(sandboxId, '/workspace/BOOTSTRAP.md');
    } catch {
      return false; // No BOOTSTRAP.md means bootstrapping is done
    }

    // Check if agent has modified IDENTITY.md or USER.md from templates
    for (const filename of ['IDENTITY.md', 'USER.md'] as const) {
      const templatePath = path.join(TEMPLATES_DIR, filename);
      if (!fs.existsSync(templatePath)) continue;

      try {
        const wsContent = await this.client.readFile(sandboxId, `/workspace/${filename}`);
        const tmplContent = fs.readFileSync(templatePath, 'utf-8');
        if (wsContent !== tmplContent) {
          // Agent modified workspace files — bootstrapping is effectively done
          // Remove BOOTSTRAP.md
          try {
            await this.client.writeFile(sandboxId, '/workspace/BOOTSTRAP.md', '');
          } catch {
            // best-effort cleanup
          }
          return false;
        }
      } catch {
        continue;
      }
    }

    return true;
  }
}

/**
 * Format the current date/time in a human-friendly way.
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
