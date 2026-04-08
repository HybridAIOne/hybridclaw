import { resolveAgentEmailAddress } from './brevo-address.js';
import { normalizeAgentHandles } from './config.js';
import { listHybridAIHandles } from './hybridai-handles.js';
import { normalizeLower } from './normalize.js';

function isLocalContext(context) {
  return (
    context.guildId == null &&
    (context.channelId === 'web' || context.channelId === 'tui')
  );
}

function normalizeHandle(value) {
  return normalizeLower(value);
}

function normalizeAgentId(value) {
  return normalizeLower(value);
}

export function resolveCurrentAgentId(api, context, defaultAgentId) {
  const sessionAgentId = normalizeAgentId(
    api.resolveSessionAgentId(context.sessionId),
  );
  if (sessionAgentId) return sessionAgentId;

  return normalizeAgentId(defaultAgentId) || 'main';
}

async function fetchHandles(api, fetchImpl) {
  const apiKey = api.getCredential('HYBRIDAI_API_KEY') || '';
  if (!apiKey) {
    throw new Error(
      'HYBRIDAI_API_KEY is not configured. Run `hybridclaw auth login hybridai` first.',
    );
  }

  return listHybridAIHandles({
    apiKey,
    baseUrl: api.config.hybridai?.baseUrl,
    fetchImpl,
  });
}

function formatHandleSummary(handles) {
  if (!handles || handles.length === 0) return '(none)';
  return handles
    .map((entry) =>
      entry.label
        ? `- ${entry.handle} (${entry.status}, ${entry.label})`
        : `- ${entry.handle} (${entry.status})`,
    )
    .join('\n');
}

function resolveHandleConflict(agentHandles, handle, currentAgentId) {
  for (const [agentId, configuredHandle] of Object.entries(agentHandles)) {
    if (agentId === currentAgentId) continue;
    if (normalizeHandle(configuredHandle) === handle) return agentId;
  }
  return null;
}

function syncRuntimeAgentHandles(config, nextAgentHandles) {
  // Resolved Brevo config is the plugin's live in-memory state. Keep it aligned
  // with persisted config writes so later commands/tools see the latest handles.
  config.agentHandles = nextAgentHandles;
}

export function createBrevoCommandHandler(api, config, options = {}) {
  const fetchImpl = options.fetchImpl;

  return async function brevoCommandHandler(args, context) {
    const sub = normalizeLower(args[0] || 'status');
    const defaultAgentId = api.config.agents?.defaultAgentId || 'main';
    const agentId = resolveCurrentAgentId(api, context, defaultAgentId);

    if (!isLocalContext(context)) {
      throw new Error(
        '`brevo` changes local runtime config and is only available from local TUI/web sessions.',
      );
    }

    if (!config.agentHandles || typeof config.agentHandles !== 'object') {
      syncRuntimeAgentHandles(config, {});
    }

    if (sub === 'status' || sub === 'info') {
      const currentHandle = normalizeHandle(config.agentHandles[agentId]);
      const currentAddress = resolveAgentEmailAddress(
        agentId,
        config.domain,
        config.fromAddress,
        currentHandle,
      );
      try {
        const result = await fetchHandles(api, fetchImpl);
        return [
          'Brevo Email',
          `Agent: ${agentId}`,
          `Attached handle: ${currentHandle || '(none)'}`,
          `Email address: ${currentAddress}`,
          `Available handles (${result.count}):`,
          formatHandleSummary(result.handles),
          '',
          'Usage: `brevo status` | `brevo list` | `brevo attach <handle>` | `brevo detach`',
        ].join('\n');
      } catch (error) {
        return [
          'Brevo Email',
          `Agent: ${agentId}`,
          `Attached handle: ${currentHandle || '(none)'}`,
          `Email address: ${currentAddress}`,
          '',
          error instanceof Error ? error.message : String(error),
        ].join('\n');
      }
    }

    if (sub === 'list' || sub === 'handles') {
      const result = await fetchHandles(api, fetchImpl);
      return [
        `Available Brevo handles (${result.count}):`,
        formatHandleSummary(result.handles),
      ].join('\n');
    }

    if (sub === 'attach') {
      const requestedHandle = normalizeHandle(args[1]);
      if (!requestedHandle) {
        throw new Error('Usage: `brevo attach <handle>`');
      }

      const result = await fetchHandles(api, fetchImpl);
      const matchedHandle = result.handles.find(
        (entry) => entry.handle === requestedHandle,
      );
      if (!matchedHandle) {
        throw new Error(
          `Handle \`${requestedHandle}\` is not reserved in your HybridAI account.`,
        );
      }
      if (matchedHandle.status !== 'active') {
        throw new Error(
          `Handle \`${requestedHandle}\` is not active (status: ${matchedHandle.status}).`,
        );
      }

      const nextAgentHandles = normalizeAgentHandles(config.agentHandles);
      const conflictingAgentId = resolveHandleConflict(
        nextAgentHandles,
        requestedHandle,
        agentId,
      );
      if (conflictingAgentId) {
        throw new Error(
          `Handle \`${requestedHandle}\` is already attached to agent \`${conflictingAgentId}\`.`,
        );
      }

      nextAgentHandles[agentId] = requestedHandle;
      await api.writeConfigValue(
        'agentHandles',
        JSON.stringify(nextAgentHandles),
      );
      syncRuntimeAgentHandles(config, nextAgentHandles);

      return [
        'Brevo handle attached.',
        `Agent: ${agentId}`,
        `Handle: ${requestedHandle}`,
        `Email address: ${resolveAgentEmailAddress(agentId, config.domain, config.fromAddress, requestedHandle)}`,
      ].join('\n');
    }

    if (sub === 'detach') {
      const nextAgentHandles = normalizeAgentHandles(config.agentHandles);
      const previousHandle = normalizeHandle(nextAgentHandles[agentId]);
      if (!previousHandle) {
        return [
          'Brevo handle unchanged.',
          `Agent: ${agentId}`,
          'Attached handle: (none)',
        ].join('\n');
      }

      delete nextAgentHandles[agentId];
      if (Object.keys(nextAgentHandles).length === 0) {
        await api.unsetConfigValue('agentHandles');
      } else {
        await api.writeConfigValue(
          'agentHandles',
          JSON.stringify(nextAgentHandles),
        );
      }
      syncRuntimeAgentHandles(config, nextAgentHandles);

      return [
        'Brevo handle detached.',
        `Agent: ${agentId}`,
        `Previous handle: ${previousHandle}`,
        `Email address: ${resolveAgentEmailAddress(agentId, config.domain, config.fromAddress)}`,
      ].join('\n');
    }

    throw new Error(
      'Usage: `brevo status` | `brevo list` | `brevo attach <handle>` | `brevo detach`',
    );
  };
}
