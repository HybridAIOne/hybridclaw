/**
 * Reset definitions live outside writable agent workspaces. A reset validates
 * the definition and exclusive ownership before removing any agent data.
 * Other agents and instance credentials remain intact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getInFlightExecutorSessionIds } from '../agent/executor.js';
import { DATA_DIR } from '../config/config.js';
import { interruptGatewaySessionExecution } from '../gateway/gateway-request-runtime.js';
import { deleteWebNotificationSession } from '../gateway/web-notification-store.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { deleteArchives } from '../memory/compaction-archive.js';
import { deleteSessionData, withMemoryDatabase } from '../memory/db.js';
import {
  applyAgentConfigJson,
  validateAgentDefaultJson,
} from './agent-config-command.js';
import {
  getAgentById,
  listAgents,
  resolveAgentWorkspaceId,
} from './agent-registry.js';
import { DEFAULT_AGENT_ID } from './agent-types.js';
import { uninstallAgent } from './agent-uninstall.js';

function defaultPath(agentId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agentId))
    throw new Error('Invalid agent id.');
  return path.join(DATA_DIR, 'agent-defaults', `${agentId}.json`);
}

export function saveAgentDefaults(rawJson: string): string {
  const validated = validateAgentDefaultJson(rawJson);
  const { agent } = JSON.parse(validated) as { agent: { id: string } };
  const file = defaultPath(agent.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, validated, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return agent.id;
}

export async function resetAgent(
  agentId: string,
  deleteHistory = true,
): Promise<{ agentId: string; deletedSessions: number }> {
  const file = defaultPath(agentId);
  if (agentId === DEFAULT_AGENT_ID)
    throw new Error('The main agent cannot be reset with this command.');
  if (!fs.existsSync(file))
    throw new Error(`No reset defaults provisioned for agent "${agentId}".`);
  const rawJson = validateAgentDefaultJson(fs.readFileSync(file, 'utf8'));
  const payload = JSON.parse(rawJson) as { agent: { id: string } };
  if (payload.agent.id !== agentId)
    throw new Error('Reset definition agent id does not match.');
  const agent = getAgentById(agentId);
  if (
    !agent ||
    resolveAgentWorkspaceId(agentId) !== agentId ||
    listAgents().some(
      (other) =>
        other.id !== agentId && resolveAgentWorkspaceId(other.id) === agentId,
    )
  ) {
    throw new Error(
      'Reset requires an installed agent with its own workspace.',
    );
  }
  // Validate the on-disk boundary before stopping sessions or deleting history.
  const root = path.dirname(agentWorkspaceDir(agentId));
  const agentsRoot = path.resolve(DATA_DIR, 'agents');
  if (
    fs.existsSync(root) &&
    (!fs
      .realpathSync(root)
      .startsWith(`${fs.realpathSync(agentsRoot)}${path.sep}`) ||
      fs.lstatSync(root).isSymbolicLink())
  ) {
    throw new Error(
      'Refusing to reset an agent outside its managed directory.',
    );
  }
  const sessions = withMemoryDatabase(
    (db) =>
      db.prepare('SELECT id FROM sessions WHERE agent_id = ?').all(agentId) as {
        id: string;
      }[],
  );
  const sessionIds = new Set(sessions.map(({ id }) => id));
  if (getInFlightExecutorSessionIds().some((id) => sessionIds.has(id))) {
    throw new Error('Agent is busy. Stop its running tasks before resetting.');
  }
  for (const { id } of sessions) interruptGatewaySessionExecution(id);
  uninstallAgent(agentId, { existingAgent: agent, keepRegistration: true });
  if (deleteHistory) {
    for (const { id } of sessions) {
      deleteSessionData(id);
      deleteWebNotificationSession(id);
      deleteArchives(id);
      const sessionRoot = path.join(
        DATA_DIR,
        'sessions',
        id.replace(/[^a-zA-Z0-9_-]/g, '_'),
      );
      fs.rmSync(sessionRoot, { recursive: true, force: true });
    }
    withMemoryDatabase((db) => {
      db.prepare('DELETE FROM canonical_sessions WHERE agent_id = ?').run(
        agentId,
      );
      db.prepare('DELETE FROM kv_store WHERE agent_id = ?').run(agentId);
      db.prepare('DELETE FROM delegation_jobs WHERE agent_id = ?').run(agentId);
      db.prepare('DELETE FROM jobs WHERE agent_id = ?').run(agentId);
    });
  }
  await applyAgentConfigJson(rawJson, { activate: true, replace: true });
  return { agentId, deletedSessions: deleteHistory ? sessions.length : 0 };
}
