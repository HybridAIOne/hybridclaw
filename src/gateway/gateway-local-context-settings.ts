/**
 * Admin skill/tool exposure edits only initial prompt selection in runtime configuration.
 * Per-agent overrides inherit instance defaults; this is not tool permission
 * management and cannot change allowlists, disabled tools, or credentials.
 */
import {
  normalizeLocalContextMode,
  normalizeLocalStarredNames,
  normalizeLocalStarterTools,
} from '../../container/shared/local-tool-config.js';
import { listAgents } from '../agents/agent-registry.js';
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';

export type LocalContextKind = 'tools' | 'skills';

export function getLocalContextSettings(kind: LocalContextKind) {
  const config = getRuntimeConfig();
  const tools = kind === 'tools';
  return {
    instance: {
      mode: tools
        ? (config.tools.localToolMode ?? 'starred')
        : (config.skills.localSkillMode ?? 'full'),
      starred:
        (tools
          ? config.tools.localStarterTools
          : config.skills.localStarterSkills) ?? [],
    },
    agents: listAgents()
      .filter((agent) => !agent.archived)
      .map((agent) => {
        const override = config.agents.list?.find(
          (entry) => entry.id === agent.id,
        );
        return {
          id: agent.id,
          name: agent.name || agent.id,
          mode:
            (tools ? override?.localToolMode : override?.localSkillMode) ??
            null,
          starred:
            (tools
              ? override?.localStarterTools
              : override?.localStarterSkills) ?? null,
        };
      }),
    disabled: tools ? config.tools.disabled : config.skills.disabled,
  };
}

export function saveLocalContextSettings(
  kind: LocalContextKind,
  body: unknown,
) {
  const tools = kind === 'tools';
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new GatewayRequestError(400, 'Expected local context settings.');
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['agentId', 'mode', 'starred'].includes(key),
    ) ||
    (input.agentId !== null &&
      (typeof input.agentId !== 'string' || !input.agentId.trim()))
  )
    throw new GatewayRequestError(
      400,
      'Choose the instance or an existing agent.',
    );
  const agentId =
    typeof input.agentId === 'string' ? input.agentId.trim() : null;
  const inherit =
    agentId !== null && input.mode === null && input.starred === null;
  let mode: 'full' | 'starred' | undefined;
  let starred: string[] | undefined;
  try {
    mode = normalizeLocalContextMode(input.mode, 'mode');
    starred = (tools ? normalizeLocalStarterTools : normalizeLocalStarredNames)(
      input.starred,
      'starred',
    );
    if (!inherit && (mode === undefined || starred === undefined))
      throw new Error('Choose a mode and zero to nine starred entries.');
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error
        ? error.message
        : 'Invalid local context settings.',
    );
  }
  if (
    agentId &&
    !listAgents().some((agent) => agent.id === agentId && !agent.archived)
  )
    throw new GatewayRequestError(404, 'Agent not found.');
  updateRuntimeConfig((draft) => {
    if (!agentId) {
      if (tools) {
        draft.tools.localToolMode = mode;
        draft.tools.localStarterTools = starred;
      } else {
        draft.skills.localSkillMode = mode;
        draft.skills.localStarterSkills = starred;
      }
      return;
    }
    draft.agents.list ??= [];
    let agent = draft.agents.list.find((entry) => entry.id === agentId);
    if (!agent) {
      if (inherit) return;
      agent = { id: agentId };
      draft.agents.list.push(agent);
    }
    if (tools) {
      if (inherit) {
        delete agent.localToolMode;
        delete agent.localStarterTools;
      } else {
        agent.localToolMode = mode;
        agent.localStarterTools = starred;
      }
    } else {
      if (inherit) {
        delete agent.localSkillMode;
        delete agent.localStarterSkills;
      } else {
        agent.localSkillMode = mode;
        agent.localStarterSkills = starred;
      }
    }
  });
  return getLocalContextSettings(kind);
}
