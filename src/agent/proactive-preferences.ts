/**
 * Proactive preferences are refreshed in appended turn context, never history.
 * Unlike proactive-policy.ts, this supplies prose guidance, not delivery gates.
 * Read failures instruct silence instead of supplying partial preferences.
 */
import fs from 'node:fs';
import path from 'node:path';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { WORKSPACE_CONTEXT_FILE_MAX_CHARS } from '../workspace.js';
import {
  PROACTIVE_PREFERENCES_FILE,
  readWorkspaceTemplate,
} from '../workspace-templates.js';
import { SILENT_REPLY_TOKEN } from './silent-reply.js';

export const PROACTIVE_PREFERENCES_GUIDANCE = [
  `Before composing or sending any unsolicited message, read the whole current ${PROACTIVE_PREFERENCES_FILE}. Follow all preferences in it, including plain words outside the headings. Reread the whole file if it changes during this turn.`,
  'Tell me about guides allowed topics; Never tell me about excludes topics even when relevant. Empty topic lists do not authorize arbitrary outreach. When guides composition using the user timezone in current context; delivery still follows runtime active hours and may wait for a quiet moment. How guides format and tone within channel capabilities.',
  `Only interrupt for something meaningfully new, useful, and worth the interruption. Honor requests to turn proactivity off, down, or up. Stay silent when nothing qualifies (HEARTBEAT_OK for heartbeat polls, otherwise ${SILENT_REPLY_TOKEN}). These preferences govern unsolicited outreach; carry out explicitly requested replies and tasks.`,
  'When the user corrects proactive topics, timing, frequency, format, or tone in chat, update this workspace file under the relevant heading, preserving unrelated preferences. Record explicit preferences, not inferred interests.',
].join('\n');

export function buildProactivePreferencesContext(agentId: string): string {
  let content: string;
  try {
    const filePath = path.join(
      agentWorkspaceDir(agentId),
      PROACTIVE_PREFERENCES_FILE,
    );
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      content = readWorkspaceTemplate(PROACTIVE_PREFERENCES_FILE);
    }
    if (content.length > WORKSPACE_CONTEXT_FILE_MAX_CHARS) {
      throw new Error('Preferences exceed the complete-file context budget');
    }
  } catch {
    return `## ${PROACTIVE_PREFERENCES_FILE}\nThe complete preferences file could not be loaded. Stay silent for unsolicited outreach until the whole file can be read. Explicitly requested replies and tasks may continue.`;
  }

  return [
    `## ${PROACTIVE_PREFERENCES_FILE}`,
    'The entire current file is included below and counts as read for this turn, superseding earlier preference snapshots.',
    '',
    content,
  ].join('\n');
}
