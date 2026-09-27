import {
  APPROVAL_MODE_PRESENTATION,
  APPROVAL_MODES,
} from '../container/shared/approval-mode.js';
import type { CanonicalSlashCommandDefinition } from './command-registry.js';

export const APPROVAL_SCOPE_MODES = [
  'once',
  'session',
  'agent',
  'all',
] as const;

export type ApprovalScopeMode = (typeof APPROVAL_SCOPE_MODES)[number];

export const APPROVE_COMMAND_ACTIONS = [
  'view',
  'yes',
  'session',
  'agent',
  'all',
  'no',
] as const;

export const APPROVE_COMMAND_USAGE = `/approve [${APPROVE_COMMAND_ACTIONS.join('|')}] [approval_id]`;

export const APPROVE_TEXT_CHANNEL_USAGE = `\`${APPROVE_COMMAND_USAGE.replace(
  '/approve ',
  '/approve action:',
)}\``;

export const APPROVALS_MODE_USAGE = `/approvals mode [${APPROVAL_MODES.join('|')}]`;

export const APPROVALS_SLASH_COMMAND: CanonicalSlashCommandDefinition = {
  name: 'approvals',
  description: 'Show or set how often this session asks for approval',
  tuiMenu: { label: APPROVALS_MODE_USAGE, insertText: '/approvals mode ' },
  tuiOnly: true,
  options: [
    {
      kind: 'subcommand',
      name: 'mode',
      description: 'Show or set the session approval mode',
      tuiMenuEntries: APPROVAL_MODES.map((mode) => ({
        id: `approvals.mode.${mode}`,
        label: `/approvals mode ${mode}`,
        insertText: `/approvals mode ${mode}`,
        description: APPROVAL_MODE_PRESENTATION[mode].description,
      })),
    },
  ],
};
