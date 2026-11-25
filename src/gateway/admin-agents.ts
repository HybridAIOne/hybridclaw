/**
 * Admin-API agent create/update/delete across SQLite and `config.json`.
 *
 * An agent defined in `agents.list[]` gets each admin edit or delete mirrored
 * into that entry, so config sync cannot revert it; if the config write fails
 * the SQLite change is rolled back. DB-only agents never touch `agents.list[]`.
 * Delete refuses the default agent and channel-bound agents.
 *
 * NOT the HTTP payload parser (`gateway-http-server.ts`) or the response
 * mapper (`gateway-service.ts`).
 */
import {
  deleteRegisteredAgent,
  getStoredAgentConfig,
  resolveAgentConfig,
  setRegisteredAgentArchived,
  upsertRegisteredAgent,
} from '../agents/agent-registry.js';
import {
  removeConfiguredAgentFromRuntimeConfig,
  syncConfiguredAgentInRuntimeConfig,
} from '../agents/agent-runtime-config.js';
import {
  type AgentConfig,
  DEFAULT_AGENT_ID,
  resolveConfiguredDefaultAgentId,
} from '../agents/agent-types.js';
import { getRuntimeConfig } from '../config/runtime-config.js';

const TRIMMED_STRING_FIELDS = [
  'extends',
  'name',
  'model',
  'chatbotId',
  'workspace',
  'role',
  'reportsTo',
] as const;
const NULLABLE_FIELDS = [
  'skills',
  'tools',
  'delegatesTo',
  'peers',
  'enableRag',
  'proxy',
] as const;

/** `null` or an empty string clears a field; `undefined` leaves it alone. */
export type GatewayAdminAgentCreateParams = {
  id: string;
} & {
  [Key in (typeof TRIMMED_STRING_FIELDS)[number]]?: string | null;
} & {
  [Key in (typeof NULLABLE_FIELDS)[number]]?: AgentConfig[Key] | null;
};

export type GatewayAdminAgentUpdateParams = Omit<
  GatewayAdminAgentCreateParams,
  'id'
> & { archived?: boolean | null };

function buildAgentPatch(
  params: Omit<GatewayAdminAgentCreateParams, 'id'>,
  includeUnset: boolean,
): Partial<AgentConfig> {
  const patch: Record<string, unknown> = {};
  for (const key of TRIMMED_STRING_FIELDS) {
    if (includeUnset || params[key] !== undefined) {
      patch[key] = params[key]?.trim() || undefined;
    }
  }
  for (const key of NULLABLE_FIELDS) {
    if (includeUnset || params[key] !== undefined) {
      patch[key] = params[key] ?? undefined;
    }
  }
  return patch as Partial<AgentConfig>;
}

function restoreOnFailure(
  agentId: string,
  previous: AgentConfig | null,
  persist: () => void,
): void {
  try {
    persist();
  } catch (error) {
    if (previous) {
      upsertRegisteredAgent(previous);
      setRegisteredAgentArchived(agentId, previous.archived === true);
    } else {
      deleteRegisteredAgent(agentId);
    }
    throw error;
  }
}

export function createAdminAgentRecord(
  params: GatewayAdminAgentCreateParams,
): AgentConfig {
  const id = params.id.trim();
  const previous = id ? getStoredAgentConfig(id) : null;
  // POST replaces the agent, so unset fields clear a config entry too.
  const patch = buildAgentPatch(params, true);
  upsertRegisteredAgent({ id, ...patch });
  restoreOnFailure(id, previous, () =>
    syncConfiguredAgentInRuntimeConfig(id, patch, {
      route: `admin.agents.create:${id}`,
      source: 'user',
    }),
  );
  return resolveAgentConfig(id);
}

export function updateAdminAgentRecord(
  agentId: string,
  params: GatewayAdminAgentUpdateParams,
): AgentConfig {
  const id = agentId.trim();
  const previous = id ? getStoredAgentConfig(id) : null;
  if (!previous) {
    throw new Error(`Agent "${agentId}" was not found.`);
  }
  if (params.archived === true && id === DEFAULT_AGENT_ID) {
    throw new Error('The main agent cannot be archived.');
  }
  const patch = buildAgentPatch(params, false);
  if (Object.keys(patch).length > 0) {
    upsertRegisteredAgent({ ...previous, ...patch });
  }
  restoreOnFailure(id, previous, () => {
    if (typeof params.archived === 'boolean') {
      setRegisteredAgentArchived(id, params.archived);
    }
    syncConfiguredAgentInRuntimeConfig(id, patch, {
      route: `admin.agents.update:${id}`,
      source: 'user',
    });
  });
  return resolveAgentConfig(id);
}

export function deleteAdminAgentRecord(agentId: string): {
  deleted: boolean;
  agentId: string;
} {
  const id = agentId.trim();
  if (!id) {
    throw new Error('Agent id is required.');
  }
  if (id === DEFAULT_AGENT_ID) {
    throw new Error('The main agent cannot be deleted.');
  }
  // Removing the entry would silently move the default route or a channel
  // binding to another agent; make the operator pick the new one first.
  const agents = getRuntimeConfig().agents;
  if (id === resolveConfiguredDefaultAgentId(agents)) {
    throw new Error(
      `Agent "${id}" is the default agent. Activate another agent first with \`hybridclaw agent activate <agent-id>\`.`,
    );
  }
  const boundChannels = Object.entries(agents.channels ?? {}).flatMap(
    ([kind, boundId]) => (boundId === id ? [kind] : []),
  );
  if (boundChannels.length > 0) {
    throw new Error(
      `Agent "${id}" answers on ${boundChannels.join(', ')}. Bind them to another agent first with \`hybridclaw agent bind <agent-id> ${boundChannels.join(' ')}\`.`,
    );
  }
  const previous = getStoredAgentConfig(id);
  const deleted = deleteRegisteredAgent(id);
  if (deleted) {
    restoreOnFailure(id, previous, () =>
      removeConfiguredAgentFromRuntimeConfig(id, {
        route: `admin.agents.delete:${id}`,
        source: 'user',
      }),
    );
  }
  return { deleted, agentId: id };
}
