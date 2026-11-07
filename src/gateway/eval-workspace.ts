/**
 * Operator-selected eval directories separate task execution from agent files.
 * Only an explicit eval request consumes this process-local host setting.
 * HTTP clients cannot choose paths; normal chat ignores it, Docker rejects it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONTAINER_SANDBOX_MODE } from '../config/config.js';
import { hostWorkspaceStateRoot } from '../infra/host-workspace.js';
import { ensureAgentDirs } from '../infra/ipc.js';
import { ensureBootstrapFiles } from '../workspace.js';

export function evalWorkspaceOverrides(
  isEval: boolean,
  agentId: string,
): {
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
} {
  const configured = process.env.HYBRIDCLAW_EVAL_WORKSPACE_ROOT?.trim();
  if (!isEval || !configured) return {};
  if (CONTAINER_SANDBOX_MODE !== 'host')
    throw new Error('An external eval workspace requires host execution');
  if (!path.isAbsolute(configured))
    throw new Error('Eval workspace must be an absolute directory');
  const workspace = fs.realpathSync(configured);
  if (!fs.statSync(workspace).isDirectory())
    throw new Error('Eval workspace must be a directory');
  ensureAgentDirs(agentId);
  const state = fs.realpathSync(hostWorkspaceStateRoot({ agentId }));
  if (
    workspace === state ||
    workspace.startsWith(state + path.sep) ||
    state.startsWith(workspace + path.sep)
  )
    throw new Error(
      'Eval workspace and agent state must be separate directories',
    );
  // Bootstrap only the agent-owned tree, before dispatch overrides execution.
  ensureBootstrapFiles(agentId);
  return {
    workspacePathOverride: workspace,
    workspaceDisplayRootOverride: workspace,
  };
}
