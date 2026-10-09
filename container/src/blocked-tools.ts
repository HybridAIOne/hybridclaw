/**
 * The request's `blockedTools` as one predicate. A plain entry blocks that
 * exact tool. An entry with `*` (any run of characters) blocks every tool it
 * matches, except those an entry starting with `!` matches: a scoped chat
 * sends `hybridai__*__*` plus `!hybridai__<service>__*` for each connector
 * service it may use, so a service nobody named stays blocked.
 *
 * Exemptions apply to `*` entries only; they never unblock an exact entry.
 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return new RegExp(`^${source}$`);
}

export function compileBlockedTools(
  entries: readonly unknown[] | undefined,
): (toolName: string) => boolean {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  const exemptions: RegExp[] = [];
  for (const raw of entries ?? []) {
    const entry = String(raw || '').trim();
    if (!entry) continue;
    if (entry.startsWith('!')) {
      if (entry.length > 1) exemptions.push(globToRegExp(entry.slice(1)));
    } else if (entry.includes('*')) {
      globs.push(globToRegExp(entry));
    } else {
      exact.add(entry);
    }
  }
  return (toolName) =>
    exact.has(toolName) ||
    (globs.some((glob) => glob.test(toolName)) &&
      !exemptions.some((exemption) => exemption.test(toolName)));
}
