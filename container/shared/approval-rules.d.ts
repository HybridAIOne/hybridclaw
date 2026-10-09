export const APPROVAL_PAUSE_CAUSES: readonly [
  'risky',
  'ask_mode',
  'protected',
  'unusual',
  'workspace_policy',
];

export type ApprovalPauseCause = (typeof APPROVAL_PAUSE_CAUSES)[number];

export type ApprovalTrustScope = 'agent' | 'all';

export const APPROVAL_TRUST_STORE_FILES: Readonly<
  Record<ApprovalTrustScope, string>
>;

export const LEGACY_AGENT_TRUST_STORE_FILE: string;

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

export function describeApprovalAction(
  actionKey: string,
): ApprovalActionDescription;

export interface ApprovalTrustGrant {
  actionKey: string;
  fingerprints: string[];
  intent?: string;
  toolName?: string;
  grantedAt?: string;
}

export interface ApprovalTrustStore {
  actions: string[];
  fingerprints: string[];
  grants: ApprovalTrustGrant[];
}

export function parseApprovalTrustStore(raw: string): ApprovalTrustStore | null;

export function serializeApprovalTrustStore(
  store: ApprovalTrustStore,
  now?: Date,
): string;

export function grantApprovalTrust(
  store: ApprovalTrustStore,
  input: {
    actionKey: string;
    fingerprint: string;
    intent?: string;
    toolName?: string;
  },
  now?: Date,
): ApprovalTrustStore;

export function revokeApprovalTrust(
  store: ApprovalTrustStore,
  actionKey: string,
): { store: ApprovalTrustStore; revoked: boolean };

export interface ApprovalRule extends ApprovalActionDescription {
  actionKey: string;
  pausedBy: ApprovalPauseCause;
}

export function approvalRuleFor(
  actionKey: string,
  pausedBy: ApprovalPauseCause,
): ApprovalRule;

export function parseApprovalRule(value: unknown): ApprovalRule | null;
