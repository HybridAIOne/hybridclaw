/**
 * Approval mode — how eager a session is to act without asking.
 *
 * `ask` prompts for every side effect, `auto` lets the traffic-light pipeline
 * decide, `full` auto-approves yellow and eligible red. No mode lifts the
 * pinned floor. NOT the per-request `/approve` scope, which answers one prompt.
 */
export const APPROVAL_MODES = ['ask', 'auto', 'full'];

export const DEFAULT_APPROVAL_MODE = 'auto';

export const APPROVAL_MODE_PRESENTATION = {
  ask: {
    label: 'Ask first',
    description:
      'Asks before every edit, command, or network call. Reads run freely.',
  },
  auto: {
    label: 'Auto',
    description: 'Routine work runs. Asks before risky or destructive actions.',
  },
  full: {
    label: 'Full access',
    description:
      'Runs everything without asking. Pinned safety rules still ask.',
  },
};

export function isApprovalMode(value) {
  return APPROVAL_MODES.includes(value);
}
