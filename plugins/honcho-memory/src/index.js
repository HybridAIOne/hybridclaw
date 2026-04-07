import { resolveHonchoPluginConfig } from './config.js';
import { formatHonchoLabel, HonchoClient } from './honcho-client.js';

function truncateText(value, maxChars) {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function latestUserQuery(recentMessages) {
  let latest = null;
  for (const message of recentMessages) {
    if (String(message?.role || '').toLowerCase() !== 'user') continue;
    if (!latest) {
      latest = message;
      continue;
    }
    const currentTime = Date.parse(String(message.created_at || ''));
    const latestTime = Date.parse(String(latest.created_at || ''));
    if (
      (Number.isFinite(currentTime) ? currentTime : Number.NEGATIVE_INFINITY) >=
      (Number.isFinite(latestTime) ? latestTime : Number.NEGATIVE_INFINITY)
    ) {
      latest = message;
    }
  }
  const content = String(latest?.content || '').trim();
  return content.length >= 3 ? content : '';
}

function formatPromptContext(result, ids, config) {
  const sections = [
    'Honcho session memory context:',
    'This context comes from prior HybridClaw turns mirrored into Honcho.',
  ];

  if (config.includeSummary && result?.summary?.content) {
    sections.push('', 'Summary:', result.summary.content.trim());
  }

  if (config.includePeerRepresentation && result?.peer_representation) {
    sections.push(
      '',
      'Peer representation:',
      String(result.peer_representation).trim(),
    );
  }

  if (
    config.includePeerCard &&
    Array.isArray(result?.peer_card) &&
    result.peer_card.length > 0
  ) {
    sections.push(
      '',
      'Peer card:',
      ...result.peer_card.map((item) => `- ${item}`),
    );
  }

  if (
    config.includeRecentMessages &&
    Array.isArray(result?.messages) &&
    result.messages.length > 0
  ) {
    const recentLines = result.messages.map((message) => {
      const label = formatHonchoLabel(
        message.peer_id,
        ids.userPeerId,
        ids.agentPeerId,
      );
      return `${label}: ${String(message.content || '').trim()}`;
    });
    sections.push('', 'Recent Honcho messages:', ...recentLines);
  }

  const content = sections.join('\n').trim();
  if (!content || content === sections[0]) return null;
  return truncateText(content, config.maxInjectedChars);
}

function formatSearchResult(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return 'No Honcho results found for this session.';
  }
  return results
    .map((message, index) =>
      [
        `[${index + 1}] ${String(message.peer_id || 'peer')} @ ${String(
          message.created_at || 'unknown',
        )}`,
        String(message.content || '').trim(),
      ].join('\n'),
    )
    .join('\n\n');
}

export default {
  id: 'honcho-memory',
  kind: 'memory',
  register(api) {
    const config = resolveHonchoPluginConfig(api.pluginConfig, api.runtime);
    const client = new HonchoClient(config);
    const lastSyncedMessageIds = new Map();

    api.registerMemoryLayer({
      id: 'honcho-memory-layer',
      priority: 45,
      async start() {
        try {
          await client.ensureWorkspace();
          api.logger.debug(
            {
              baseUrl: config.baseUrl,
              workspaceId: config.workspaceId,
            },
            'Honcho startup health-check passed',
          );
        } catch (error) {
          api.logger.warn(
            {
              error,
              baseUrl: config.baseUrl,
              workspaceId: config.workspaceId,
            },
            'Honcho startup health-check failed',
          );
        }
      },
      async getContextForPrompt({
        sessionId,
        userId,
        agentId,
        recentMessages,
      }) {
        try {
          const query = latestUserQuery(recentMessages);
          const result = await client.getSessionContext({
            sessionId,
            userId,
            agentId,
            searchQuery: query,
          });
          const ids = await client.ensureConversation({
            sessionId,
            userId,
            agentId,
          });
          const promptContext = formatPromptContext(result, ids, config);
          api.logger.debug(
            {
              baseUrl: config.baseUrl,
              workspaceId: config.workspaceId,
              hasQuery: Boolean(query),
            },
            promptContext
              ? 'Honcho prompt context injected'
              : 'Honcho prompt context unavailable',
          );
          return promptContext;
        } catch (error) {
          api.logger.warn(
            {
              error,
              baseUrl: config.baseUrl,
              workspaceId: config.workspaceId,
            },
            'Honcho prompt context fetch failed',
          );
          return null;
        }
      },
      async onTurnComplete({ sessionId, userId, agentId, messages }) {
        if (!config.autoSync) return;
        const lastSyncedMessageId = lastSyncedMessageIds.get(sessionId) || 0;
        const unsyncedMessages = messages.filter(
          (message) => Number(message.id) > lastSyncedMessageId,
        );
        if (unsyncedMessages.length === 0) return;
        await client.syncMessages({
          sessionId,
          userId,
          agentId,
          messages: unsyncedMessages,
        });
        const maxMessageId = unsyncedMessages.reduce(
          (maxId, message) => Math.max(maxId, Number(message.id) || 0),
          lastSyncedMessageId,
        );
        lastSyncedMessageIds.set(sessionId, maxMessageId);
      },
    });

    api.registerCommand({
      name: 'honcho',
      description: 'Inspect Honcho sync status or search the mirrored session',
      async handler(args, context) {
        const normalizedArgs = args
          .map((arg) => String(arg || '').trim())
          .filter(Boolean);
        const subcommand = String(normalizedArgs[0] || 'status').toLowerCase();
        try {
          if (subcommand === 'search') {
            const query = normalizedArgs.slice(1).join(' ').trim();
            if (!query) {
              return 'Usage: /honcho search <query>';
            }
            const results = await client.searchSession({
              sessionId: context.sessionId,
              query,
              limit: config.searchLimit,
            });
            return formatSearchResult(results);
          }

          const status = await client.getQueueStatus(context.sessionId);
          return [
            'Honcho status',
            `Base URL: ${config.baseUrl}`,
            `Workspace: ${config.workspaceId}`,
            `Session: ${context.sessionId}`,
            `Pending work units: ${Number(status?.pending_work_units || 0)}`,
            `In-progress work units: ${Number(status?.in_progress_work_units || 0)}`,
            `Completed work units: ${Number(status?.completed_work_units || 0)}`,
          ].join('\n');
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error || 'Unknown error');
          return [
            'Honcho command failed.',
            `Base URL: ${config.baseUrl}`,
            `Workspace: ${config.workspaceId}`,
            `Session: ${context.sessionId}`,
            '',
            message,
          ].join('\n');
        }
      },
    });

    api.logger.info(
      {
        baseUrl: config.baseUrl,
        workspaceId: config.workspaceId,
        autoSync: config.autoSync,
      },
      'Honcho memory plugin registered',
    );
  },
};
