/**
 * Onboarding switch-off — leaves an agent with no first-run hatching to do:
 * no BOOTSTRAP.md, a workspace state that says onboarding is complete, and no
 * gateway autostart claim for an earlier BOOTSTRAP.md.
 *
 * The registry's `onboarding: false` keeps it that way (workspace.ts checks it
 * on every bootstrap pass, so a wiped workspace never hatches); this module
 * clears what already exists. NOT the hatching flow itself
 * (`gateway/hatching-completion.ts`).
 */
import {
  deleteMemoryValuesByKey,
  deleteMemoryValuesByKeyPrefix,
} from '../memory/db.js';
import { completeWorkspaceOnboarding } from '../workspace.js';

export const BOOTSTRAP_AUTOSTART_MARKER_PREFIX =
  'gateway.bootstrap_autostart.v1';

export function clearBootstrapAutostartMarkers(agentId: string): number {
  const key = `${BOOTSTRAP_AUTOSTART_MARKER_PREFIX}.${agentId}`;
  return (
    deleteMemoryValuesByKey(key) + deleteMemoryValuesByKeyPrefix(`${key}.`)
  );
}

export function turnOffAgentOnboarding(agentId: string): void {
  completeWorkspaceOnboarding(agentId);
  clearBootstrapAutostartMarkers(agentId);
}
