import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Whether a bare module specifier resolves the way an agent-written script
 * would resolve it: from the given directory (default: the process working
 * directory), including the NODE_PATH entries the runtime images set for the
 * shared tool libraries under /opt/hybridclaw-tools.
 *
 * Only presence is cached, like executable lookups, so a library installed
 * after the first probe becomes visible without a restart.
 */
const presentModules = new Set<string>();

export function hasResolvableNodeModule(
  specifier: string,
  options?: { cwd?: string },
): boolean {
  const normalized = String(specifier || '').trim();
  if (
    !normalized ||
    normalized.startsWith('.') ||
    path.isAbsolute(normalized)
  ) {
    return false;
  }
  const cwd = options?.cwd ?? process.cwd();
  const key = `${cwd}\0${normalized}`;
  if (presentModules.has(key)) return true;
  try {
    createRequire(path.join(cwd, '__hybridclaw_module_probe__.cjs')).resolve(
      normalized,
    );
    presentModules.add(key);
    return true;
  } catch {
    return false;
  }
}
