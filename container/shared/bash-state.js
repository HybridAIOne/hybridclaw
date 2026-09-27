// What the bash tool keeps between calls, stated once: the bash tool
// description and the gateway system prompt both quote it.
export function describeBashStatePersistence(persistent) {
  return persistent
    ? 'The first shell starts in the workspace root. `cd` persists for the rest of the session; exported env vars and aliases persist only until the sandbox restarts (after idle time or a provider switch), and the first bash result after a restart says so.'
    : 'Each bash call starts fresh in the workspace root, so `cd`, exported env vars, and aliases do not persist to later bash calls.';
}
