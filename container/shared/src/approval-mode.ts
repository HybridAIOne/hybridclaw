/**
 * Approval mode — how eager a session is to act without asking.
 *
 * `ask` prompts for every side effect, `auto` lets the traffic-light pipeline
 * decide, `full` auto-approves yellow and eligible red. `learning` records prompts
 * and notices while allowing them, including pinned approvals; unconditional
 * denials remain enforced. NOT `/approve`, which answers one prompt.
 */
export const APPROVAL_MODES = ['ask', 'auto', 'full', 'learning'] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

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

/** The normal auto-mode decision observed without asking or granting trust. */
export interface ApprovalObservation {
  decision: 'required' | 'implicit';
  tier: 'green' | 'yellow' | 'red';
  pinned: boolean;
  reason: string;
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
