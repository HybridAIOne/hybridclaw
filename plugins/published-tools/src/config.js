/**
 * Published-tool config — turns the validated plugin config into the tool
 * table the MCP endpoint serves. Invalid entries fail plugin load; nothing is
 * skipped, so the host never sees a partial or silently widened tool set.
 */

export const GET_RESULT_TOOL_NAME = 'hybridclaw_get_result';
const UNRESTRICTED_TOOLS = '*';

/**
 * @typedef {object} PublishedTool
 * @property {string} name
 * @property {string} [title]
 * @property {string} description
 * @property {string} instructions
 * @property {string} agentId
 * @property {string} [model] Pins the turn's model; routing does not override it.
 * @property {string[] | undefined} allowedTools Undefined keeps the agent's own tool list.
 */

/**
 * @typedef {object} PublishedToolsConfig
 * @property {string} instructions
 * @property {number} syncWaitMs
 * @property {Set<string>} allowedOrigins
 * @property {boolean} allowUrlToken
 * @property {PublishedTool[]} tools
 */

function knownAgentIds(runtimeConfig) {
  const ids = new Set(['main']);
  const defaultAgentId = runtimeConfig.agents?.defaultAgentId;
  if (defaultAgentId) ids.add(defaultAgentId);
  for (const agent of runtimeConfig.agents?.list ?? []) {
    if (agent?.id) ids.add(agent.id);
  }
  return ids;
}

function resolveAllowedTools(name, allowedTools) {
  if (allowedTools.includes(UNRESTRICTED_TOOLS)) {
    if (allowedTools.length > 1) {
      throw new Error(
        `Published tool "${name}": "*" cannot be combined with tool names.`,
      );
    }
    return undefined;
  }
  return [...new Set(allowedTools.map((tool) => tool.trim()))];
}

/**
 * @param {Record<string, unknown>} pluginConfig Schema-validated plugin config, defaults applied.
 * @param {{ agents?: { defaultAgentId?: string, list?: Array<{ id?: string }> } }} runtimeConfig
 * @returns {PublishedToolsConfig}
 */
export function resolvePublishedToolsConfig(pluginConfig, runtimeConfig) {
  const agents = knownAgentIds(runtimeConfig);
  const defaultAgentId = runtimeConfig.agents?.defaultAgentId || 'main';
  const seen = new Set();
  const tools = pluginConfig.tools.map((entry) => {
    const name = entry.name;
    if (name === GET_RESULT_TOOL_NAME || seen.has(name)) {
      throw new Error(`Published tool name "${name}" is reserved or reused.`);
    }
    seen.add(name);
    const agentId = entry.agentId?.trim() || defaultAgentId;
    if (!agents.has(agentId)) {
      throw new Error(`Published tool "${name}": unknown agent "${agentId}".`);
    }
    return {
      name,
      ...(entry.title?.trim() ? { title: entry.title.trim() } : {}),
      description: entry.description.trim(),
      instructions: entry.instructions.trim(),
      agentId,
      ...(entry.model?.trim() ? { model: entry.model.trim() } : {}),
      allowedTools: resolveAllowedTools(name, entry.allowedTools),
    };
  });
  return {
    instructions: pluginConfig.instructions.trim(),
    syncWaitMs: Math.round(pluginConfig.syncWaitSeconds * 1000),
    allowedOrigins: new Set(pluginConfig.allowedOrigins),
    allowUrlToken: pluginConfig.allowUrlToken,
    tools,
  };
}
