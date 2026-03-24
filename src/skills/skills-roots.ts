import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-config.js';
import { resolveInstallPath } from '../infra/install-root.js';

export function resolveManagedCommunitySkillsDir(
  homeDir = DEFAULT_RUNTIME_HOME_DIR,
): string {
  return path.join(homeDir, 'skills');
}

export function resolvePackagedCommunitySkillsDir(): string {
  return resolveInstallPath('community-skills');
}
