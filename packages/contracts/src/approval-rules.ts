/**
 * Approval rule wire data: the rule a pending approval shows, naming why the
 * pipeline paused a call and the kind of action an "always allow" would cover.
 *
 * NOT the describer, parser, or trust stores (`@hybridclaw/shared/approval-rules`),
 * and NOT the approval pipeline (`container/src/approval-policy.ts`).
 */

/** Why the pipeline paused a call, from the rule that raised it. */
export const APPROVAL_PAUSE_CAUSES = [
  'risky',
  'ask_mode',
  'protected',
  'unusual',
  'workspace_policy',
] as const;

export type ApprovalPauseCause = (typeof APPROVAL_PAUSE_CAUSES)[number];

export type ApprovalActionCategory =
  | 'delete_files'
  | 'change_files'
  | 'memory'
  | 'run_commands'
  | 'install_packages'
  | 'run_downloaded_code'
  | 'control_computer'
  | 'outside_workspace'
  | 'web_requests'
  | 'send_to_websites'
  | 'web_search'
  | 'send_messages'
  | 'browser'
  | 'purchase'
  | 'cancel_subscription'
  | 'connector'
  | 'tool';

export interface ApprovalActionDescription {
  category: ApprovalActionCategory;
  target?: string;
  /** English, for text channels; apps localize `category`. */
  label: string;
}

export interface ApprovalRule extends ApprovalActionDescription {
  actionKey: string;
  pausedBy: ApprovalPauseCause;
}
