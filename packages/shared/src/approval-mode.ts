/**
 * Approval mode runtime: the product default, the labels clients show, and
 * the normalizer that fails closed on an unknown mode. The mode list itself
 * is wire data (`@hybridclaw/contracts/approval-mode`). NOT `/approve`, which
 * answers one prompt.
 */
import {
  APPROVAL_MODES,
  type ApprovalMode,
} from '@hybridclaw/contracts/approval-mode';

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto';

export const APPROVAL_MODE_PRESENTATION: Readonly<
  Record<ApprovalMode, { label: string; description: string }>
> = {
  ask: {
    label: 'Ask first',
    description:
      'Asks before every edit, command, or network call. Reads run freely.',
  },
  auto: {
    label: 'Auto',
    description: 'Routine work runs. Asks before risky or destructive actions.',
  },
  learning: {
    label: 'Learning',
    description:
      'Logs approval flags and runs without prompting, including pinned actions. Hard safety blocks still apply.',
  },
  full: {
    label: 'Full access',
    description:
      'Runs everything without asking. Pinned safety rules still ask.',
  },
};

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (APPROVAL_MODES as readonly unknown[]).includes(value);
}

/** Missing configuration preserves the product default; invalid modes fail closed. */
export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === undefined) return DEFAULT_APPROVAL_MODE;
  if (!isApprovalMode(value)) throw new Error('Unknown approval mode.');
  return value;
}

/** Gateway-owned settings; each session stores its own choice. */
export interface ApprovalSettingsResponse {
  defaultMode: ApprovalMode;
  sessions: Array<{
    id: string;
    agentId: string;
    channelId: string;
    storedMode: ApprovalMode;
    effectiveMode: ApprovalMode;
  }>;
}

export type ApprovalSettingsUpdate = {
  mode: ApprovalMode;
  expectedMode: ApprovalMode;
} & ({ target: 'default' } | { target: 'session'; sessionId: string });
