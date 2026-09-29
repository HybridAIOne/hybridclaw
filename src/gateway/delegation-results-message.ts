/**
 * Delegation results message — the turn input that wakes a parent agent when
 * its background `delegate` children finish.
 *
 * It is stored as a user turn so the parent keeps the results in context, but
 * the user never typed it: history views hide it. NOT the subagent task
 * handoff (`gateway-delegation.ts` builds that for the child).
 */

export const DELEGATION_RESULTS_SOURCE = 'delegate:results';

const DELEGATION_RESULTS_HEADER = '[Delegate results]';

export function buildDelegationResultsMessage(results: string): string {
  return [
    DELEGATION_RESULTS_HEADER,
    'The delegate jobs you started earlier have finished. The user has not seen their reports.',
    "Answer the user's request from them. If a job failed, was blocked, or lacked access you have, do that part yourself.",
    '',
    results.trim(),
  ].join('\n');
}

export function isDelegationResultsMessage(content: string): boolean {
  return String(content || '').startsWith(DELEGATION_RESULTS_HEADER);
}
