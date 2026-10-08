/**
 * Host-sandbox agents load the shared skill libraries (container/tools) from
 * the gateway install, its NODE_PATH, or the data-dir copy `skill setup`
 * installs. An upgrade from a release whose gateway package carried them, or
 * to a release with a new lockfile, leaves them missing until setup runs; this
 * check names the command. It never installs anything itself, and reports
 * nothing to fix for container agents, whose image carries the libraries.
 */
import { getResolvedSandboxMode } from '../../config/config.js';
import {
  hasAgentNodeModule,
  hostRuntimeToolsDir,
  hostRuntimeToolsStale,
  sharedSkillLibraryNames,
} from '../../skills/skill-node-modules.js';
import type { DiagResult } from '../types.js';
import { makeResult } from '../utils.js';

const LABEL = 'Skill libraries';

export async function checkHostSkillLibraries(): Promise<DiagResult[]> {
  if (getResolvedSandboxMode() !== 'host') {
    return [
      makeResult(
        'skills',
        LABEL,
        'ok',
        'Container agents use the libraries in the agent image',
      ),
    ];
  }
  let libraries: string[];
  try {
    libraries = sharedSkillLibraryNames();
  } catch {
    return [
      makeResult(
        'skills',
        LABEL,
        'warn',
        'This installation lacks container/tools/package.json, so the shared skill libraries cannot be installed for host agents. Reinstall from the npm package.',
      ),
    ];
  }
  const missing = libraries.filter((name) => !hasAgentNodeModule(name, 'host'));
  if (missing.length === 0) {
    return [
      makeResult(
        'skills',
        LABEL,
        'ok',
        `Host agents resolve all ${libraries.length} shared skill libraries`,
      ),
    ];
  }
  const stale = hostRuntimeToolsStale()
    ? ` The copy in ${hostRuntimeToolsDir()} was installed for another release.`
    : '';
  return [
    makeResult(
      'skills',
      LABEL,
      'warn',
      `Host-sandbox agents cannot load ${missing.join(', ')}: skills that need them stay disabled, and scripts that require them fail with MODULE_NOT_FOUND.${stale} Run \`hybridclaw skill setup xlsx\`.`,
    ),
  ];
}
