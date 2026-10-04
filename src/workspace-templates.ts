/**
 * Shipped workspace defaults — only bootstrap filenames can resolve to templates.
 * Unlike workspace.ts, this module never reads or changes an agent's workspace.
 * Unknown filenames have no default; missing shipped templates fail explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstallPath } from './infra/install-root.js';

export const PROACTIVE_PREFERENCES_FILE = 'PROACTIVE_PREFERENCES.md';

export const WORKSPACE_BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  PROACTIVE_PREFERENCES_FILE,
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'OPENING.md',
  'BOOT.md',
] as const;

export const WORKSPACE_TEMPLATES_DIR = resolveInstallPath('templates');
const templateFileCache = new Map<string, string>();

export function readWorkspaceTemplate(
  filename: (typeof WORKSPACE_BOOTSTRAP_FILES)[number],
): string;
export function readWorkspaceTemplate(filename: string): string | null;
export function readWorkspaceTemplate(filename: string): string | null {
  const templateName = WORKSPACE_BOOTSTRAP_FILES.find(
    (name) => name === filename,
  );
  if (!templateName) return null;
  const cached = templateFileCache.get(templateName);
  if (cached != null) return cached;
  const content = fs.readFileSync(
    path.join(WORKSPACE_TEMPLATES_DIR, templateName),
    'utf-8',
  );
  templateFileCache.set(templateName, content);
  return content;
}
