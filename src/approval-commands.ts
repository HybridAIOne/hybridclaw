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
  'always',
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
