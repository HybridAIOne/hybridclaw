/**
 * Agent uninstall — removes what an install left behind: the agent's folder
 * (never anything outside `<data>/agents/`), its registry entry, its
 * bootstrap-autostart markers, and the `skills.extraDirs` entry a `.claw`
 * install adds for its workspace skills.
 *
 * NOT the admin console's agent delete (`deleteGatewayAdminAgent`), which
 * drops the registration only and keeps the folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { normalizeTrimmedString as normalizeString } from '../utils/normalized-strings.js';
import { expandHomePath } from '../utils/path.js';
import { clearBootstrapAutostartMarkers } from './agent-onboarding.js';
import { deleteRegisteredAgent, getAgentById } from './agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from './agent-types.js';

export interface UninstallAgentResult {
  agentId: string;
  agentRootPath: string;
  workspacePath: string;
  removedAgentRoot: boolean;
  removedRegistration: boolean;
  removedSkillsExtraDir: boolean;
  removedBootstrapAutostartMarkers: number;
}

export interface UninstallAgentOptions {
  existingAgent?: AgentConfig | null;
  keepRegistration?: boolean;
}

export function uninstallAgent(
  agentId: string,
  options: UninstallAgentOptions = {},
): UninstallAgentResult {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    throw new Error('Agent id is required.');
  }
  if (normalizedAgentId === DEFAULT_AGENT_ID) {
    throw new Error('The main agent cannot be uninstalled.');
  }

  const workspacePath = agentWorkspaceDir(normalizedAgentId);
  const agentRootPath = path.dirname(workspacePath);
  const expectedAgentsRootPath = path.resolve(DATA_DIR, 'agents');
  const normalizedAgentRootPath = path.resolve(agentRootPath);
  const relativeAgentRootPath = path.relative(
    expectedAgentsRootPath,
    normalizedAgentRootPath,
  );
  if (
    !relativeAgentRootPath ||
    relativeAgentRootPath.startsWith('..') ||
    path.isAbsolute(relativeAgentRootPath)
  ) {
    throw new Error(
      `Refusing to remove agent files outside ${expectedAgentsRootPath}.`,
    );
  }
  const existingAgent =
    options.existingAgent === undefined
      ? getAgentById(normalizedAgentId)
      : options.existingAgent;
  const agentRootExists = fs.existsSync(agentRootPath);
  if (agentRootExists) {
    const resolvedAgentsRootPath = fs.realpathSync.native(
      expectedAgentsRootPath,
    );
    const resolvedAgentRootPath = fs.realpathSync.native(agentRootPath);
    if (
      resolvedAgentRootPath === resolvedAgentsRootPath ||
      !resolvedAgentRootPath.startsWith(`${resolvedAgentsRootPath}${path.sep}`)
    ) {
      throw new Error(
        `Refusing to remove agent files outside ${expectedAgentsRootPath}.`,
      );
    }
  }
  // A .claw install adds this dir to the global skills.extraDirs. Left behind,
  // a later turn for this id recreates it and every agent loads its skills.
  const workspaceSkillsDir = path.resolve(workspacePath, 'skills');
  const isWorkspaceSkillsDir = (dir: string) =>
    path.resolve(expandHomePath(dir)) === workspaceSkillsDir;
  const hasSkillsExtraDir =
    getRuntimeConfig().skills.extraDirs.some(isWorkspaceSkillsDir);
  // An entry alone still counts as installed, so uninstalling again clears
  // what an earlier uninstall left in config.
  if (!existingAgent && !agentRootExists && !hasSkillsExtraDir) {
    throw new Error(`Agent "${normalizedAgentId}" is not installed.`);
  }

  if (agentRootExists) {
    fs.rmSync(agentRootPath, { recursive: true, force: true });
  }
  const removedRegistration =
    existingAgent && !options.keepRegistration
      ? deleteRegisteredAgent(normalizedAgentId)
      : false;
  if (hasSkillsExtraDir) {
    updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = draft.skills.extraDirs.filter(
        (dir) => !isWorkspaceSkillsDir(dir),
      );
    });
  }
  const removedBootstrapAutostartMarkers =
    clearBootstrapAutostartMarkers(normalizedAgentId);
  return {
    agentId: normalizedAgentId,
    agentRootPath,
    workspacePath,
    removedAgentRoot: agentRootExists,
    removedRegistration,
    removedSkillsExtraDir: hasSkillsExtraDir,
    removedBootstrapAutostartMarkers,
  };
}
