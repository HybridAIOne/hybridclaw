// What the bash tool keeps between calls, stated once: the bash tool
// description and the gateway system prompt both quote it.
export function describeBashStatePersistence(persistent: boolean): string {
  return persistent
    ? 'Every bash call starts in the workspace root, the directory other tools resolve relative paths from, so a `cd` lasts only for its own call. Exported env vars, aliases, and activated virtualenvs persist until the sandbox restarts (after idle time or a provider switch), and the first bash result after a restart says so.'
    : 'Each bash call starts fresh in the workspace root, so `cd`, exported env vars, and aliases do not persist to later bash calls.';
}
