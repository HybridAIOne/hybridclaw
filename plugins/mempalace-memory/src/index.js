import { resolveMempalacePluginConfig } from './config.js';
import {
  cleanSearchText,
  cleanWakeUpText,
  runMempalace,
  runMempalaceCommandText,
} from './mempalace-process.js';
import { writeTurnExport } from './session-export.js';

const MAX_SEARCH_QUERY_CHARS = 800;

function truncateText(value, maxChars) {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSearchQuery(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < 3) return '';
  if (normalized.length <= MAX_SEARCH_QUERY_CHARS) {
    return normalized;
  }
  return `${normalized
    .slice(0, Math.max(0, MAX_SEARCH_QUERY_CHARS - 1))
    .trimEnd()}…`;
}

function getLatestUserQuery(recentMessages) {
  let latestMessage = null;
  for (const message of recentMessages) {
    if (String(message?.role || '').toLowerCase() !== 'user') continue;
    if (!latestMessage) {
      latestMessage = message;
      continue;
    }
    const currentTime = Date.parse(String(message.created_at || ''));
    const latestTime = Date.parse(String(latestMessage.created_at || ''));
    if (
      (Number.isFinite(currentTime) ? currentTime : Number.NEGATIVE_INFINITY) >=
      (Number.isFinite(latestTime) ? latestTime : Number.NEGATIVE_INFINITY)
    ) {
      latestMessage = message;
    }
  }
  return normalizeSearchQuery(latestMessage?.content);
}

function buildSearchArgs(query, config) {
  const args = ['search', query, '--results', String(config.maxResults)];
  if (config.searchWing) {
    args.push('--wing', config.searchWing);
  }
  if (config.searchRoom) {
    args.push('--room', config.searchRoom);
  }
  return args;
}

function buildWakeUpArgs(config) {
  const args = ['wake-up'];
  if (config.wakeUpWing) {
    args.push('--wing', config.wakeUpWing);
  }
  return args;
}

function resolveUpdateWing(config, agentId) {
  return (
    String(config.updateWing || '').trim() ||
    String(config.wakeUpWing || '').trim() ||
    String(config.searchWing || '').trim() ||
    String(agentId || '').trim() ||
    'hybridclaw'
  );
}

function buildMineArgs(turnDir, config, agentId) {
  return [
    'mine',
    turnDir,
    '--mode',
    'convos',
    '--wing',
    resolveUpdateWing(config, agentId),
    '--agent',
    config.updateAgent,
  ];
}

function cloneMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => ({ ...message }));
}

function buildMemoryWriteMirrorMessages(context) {
  const createdAt = new Date().toISOString();
  const userContent = [
    'Mirror this explicit HybridClaw native memory write into MemPalace.',
    `File: ${context.memoryFilePath}`,
    `Action: ${context.action}`,
  ].join('\n');

  let assistantContent = '';
  if (context.action === 'append' || context.action === 'write') {
    assistantContent = String(context.content || '').trim();
  } else if (context.action === 'replace') {
    assistantContent = String(context.newText || '').trim();
  } else if (context.action === 'remove') {
    assistantContent = `HybridClaw removed content from ${context.memoryFilePath}.`;
  }

  if (!assistantContent) {
    assistantContent = `HybridClaw updated ${context.memoryFilePath} with action ${context.action}.`;
  }

  return [
    {
      role: 'user',
      content: userContent,
      created_at: createdAt,
    },
    {
      role: 'assistant',
      content: assistantContent,
      created_at: createdAt,
    },
  ];
}

async function mineMessages(params) {
  const exportResult = await writeTurnExport({
    exportDir: params.config.sessionExportDir,
    sessionId: params.sessionId,
    userId: params.userId,
    agentId: params.agentId,
    messages: params.messages,
  });
  const commandArgs = buildMineArgs(
    exportResult.turnDir,
    params.config,
    params.agentId,
  );
  const mineOutput = await runMempalaceCommandText(commandArgs, params.config, {
    maxChars: 2_000,
    timeoutMs: Math.max(params.config.timeoutMs, 30_000),
  });
  params.api.logger.debug(
    {
      sessionId: params.sessionId,
      reason: params.reason,
      messageCount: params.messages.length,
      filePath: exportResult.filePath,
      turnDir: exportResult.turnDir,
      wing: resolveUpdateWing(params.config, params.agentId),
      output: truncateText(mineOutput, 400),
    },
    'MemPalace transcript batch mined',
  );
}

function createAutoSaveBuffer(config, api) {
  const sessionBuffers = new Map();
  const flushQueue = new Map();

  function getSessionBuffer(sessionId, meta = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      throw new Error('MemPalace auto-save requires a session id.');
    }
    const existing = sessionBuffers.get(normalizedSessionId);
    if (existing) {
      if (meta.userId) existing.userId = String(meta.userId);
      if (meta.agentId) existing.agentId = String(meta.agentId);
      if (meta.channelId) existing.channelId = String(meta.channelId);
      return existing;
    }
    const created = {
      sessionId: normalizedSessionId,
      userId: String(meta.userId || ''),
      agentId: String(meta.agentId || ''),
      channelId: String(meta.channelId || ''),
      messages: [],
    };
    sessionBuffers.set(normalizedSessionId, created);
    return created;
  }

  async function flushSessionNow(sessionId, reason) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return false;
    const buffer = sessionBuffers.get(normalizedSessionId);
    if (!buffer || buffer.messages.length === 0) return false;

    const snapshot = cloneMessages(buffer.messages);
    const userId = buffer.userId;
    const agentId = buffer.agentId;
    buffer.messages = [];

    try {
      await mineMessages({
        api,
        config,
        sessionId: normalizedSessionId,
        userId,
        agentId,
        messages: snapshot,
        reason,
      });
      if (buffer.messages.length === 0) {
        sessionBuffers.delete(normalizedSessionId);
      }
      return true;
    } catch (error) {
      buffer.messages = [...snapshot, ...buffer.messages];
      api.logger.warn(
        {
          error,
          sessionId: normalizedSessionId,
          reason,
          exportDir: config.sessionExportDir,
        },
        'MemPalace transcript batch mining failed',
      );
      return false;
    }
  }

  async function queueFlush(sessionId, reason) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return false;
    const previous = flushQueue.get(normalizedSessionId) || Promise.resolve();
    const next = previous
      .catch(() => false)
      .then(() => flushSessionNow(normalizedSessionId, reason));
    flushQueue.set(normalizedSessionId, next);
    try {
      return await next;
    } finally {
      if (flushQueue.get(normalizedSessionId) === next) {
        flushQueue.delete(normalizedSessionId);
      }
    }
  }

  return {
    async appendMessages(params) {
      const buffer = getSessionBuffer(params.sessionId, params);
      const additions = cloneMessages(params.messages);
      if (additions.length === 0) return false;
      buffer.messages.push(...additions);
      if (buffer.messages.length < config.saveEveryMessages) {
        return false;
      }
      return await queueFlush(buffer.sessionId, 'message threshold');
    },
    async flushSession(sessionId, reason) {
      return await queueFlush(sessionId, reason);
    },
    async flushAll(reason) {
      const sessionIds = [...sessionBuffers.keys()];
      await Promise.all(
        sessionIds.map((sessionId) => queueFlush(sessionId, reason)),
      );
    },
  };
}

async function buildPromptContext(config, recentMessages) {
  const sections = [];

  if (config.wakeUpEnabled) {
    const wakeUpText = cleanWakeUpText(
      await runMempalaceCommandText(buildWakeUpArgs(config), config, {
        maxChars: config.maxWakeUpChars,
      }),
      config.maxWakeUpChars,
    );
    if (wakeUpText) {
      sections.push(
        [
          'MemPalace wake-up context:',
          "This comes from MemPalace's local long-term memory stack.",
          '',
          wakeUpText,
        ].join('\n'),
      );
    }
  }

  const query = config.searchEnabled ? getLatestUserQuery(recentMessages) : '';
  if (query) {
    const searchText = cleanSearchText(
      await runMempalaceCommandText(buildSearchArgs(query, config), config, {
        maxChars: config.maxSearchChars,
      }),
      config.maxSearchChars,
    );
    if (searchText) {
      sections.push(
        [
          'MemPalace search results for the latest user question:',
          `Query: ${query}`,
          '',
          searchText,
        ].join('\n'),
      );
    }
  }

  if (sections.length === 0) return null;
  return truncateText(sections.join('\n\n'), config.maxInjectedChars);
}

function formatCommandFailure(error, config, args) {
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error');
  return [
    'MemPalace command failed.',
    `Command: ${config.command}`,
    `Working directory: ${config.workingDirectory}`,
    ...(config.palacePath ? [`Palace path: ${config.palacePath}`] : []),
    ...(args.length > 0 ? [`Arguments: ${args.join(' ')}`] : []),
    '',
    message,
  ].join('\n');
}

export default {
  id: 'mempalace-memory',
  kind: 'memory',
  register(api) {
    const config = resolveMempalacePluginConfig(api.pluginConfig, api.runtime);
    const autoSave = createAutoSaveBuffer(config, api);

    api.registerMemoryLayer({
      id: 'mempalace-memory-layer',
      priority: 55,
      async start() {
        try {
          const result = await runMempalace(['status'], config, {
            maxChars: 2000,
          });
          if (!result.ok) {
            throw result.error;
          }
          api.logger.debug(
            {
              command: config.command,
              workingDirectory: config.workingDirectory,
              palacePath: config.palacePath || null,
            },
            'MemPalace startup health-check passed',
          );
        } catch (error) {
          api.logger.warn(
            {
              error,
              command: config.command,
              workingDirectory: config.workingDirectory,
              palacePath: config.palacePath || null,
            },
            'MemPalace startup health-check failed',
          );
        }
      },
      async getContextForPrompt({ recentMessages }) {
        try {
          const promptContext = await buildPromptContext(
            config,
            recentMessages,
          );
          api.logger.debug(
            {
              wakeUpEnabled: config.wakeUpEnabled,
              searchEnabled: config.searchEnabled,
              workingDirectory: config.workingDirectory,
            },
            promptContext
              ? 'MemPalace prompt context injected'
              : 'MemPalace prompt context skipped',
          );
          return promptContext;
        } catch (error) {
          api.logger.warn(
            {
              error,
              command: config.command,
              workingDirectory: config.workingDirectory,
            },
            'MemPalace prompt context build failed',
          );
          return null;
        }
      },
    });

    api.on(
      'agent_end',
      async ({ sessionId, userId, agentId, channelId, messages }) => {
        await autoSave.appendMessages({
          sessionId,
          userId,
          agentId,
          channelId,
          messages,
        });
      },
    );

    api.on('memory_write', async (context) => {
      await mineMessages({
        api,
        config,
        sessionId: context.sessionId,
        userId: 'hybridclaw-memory',
        agentId: context.agentId,
        messages: buildMemoryWriteMirrorMessages(context),
        reason: `native memory ${context.action}`,
      });
    });

    api.on('before_compaction', async ({ sessionId }) => {
      await autoSave.flushSession(sessionId, 'before compaction');
    });

    api.on('session_end', async ({ sessionId }) => {
      await autoSave.flushSession(sessionId, 'session end');
    });

    api.on('session_reset', async ({ previousSessionId }) => {
      await autoSave.flushSession(previousSessionId, 'session reset');
    });

    api.on('gateway_stop', async () => {
      await autoSave.flushAll('gateway stop');
    });

    api.registerCommand({
      name: 'mempalace',
      description: 'Run MemPalace CLI commands (defaults to status)',
      async handler(args) {
        const normalizedArgs = args
          .map((arg) => String(arg || '').trim())
          .filter(Boolean);
        const commandArgs =
          normalizedArgs.length > 0 ? normalizedArgs : ['status'];
        try {
          return await runMempalaceCommandText(commandArgs, config, {
            maxChars: 8000,
            timeoutMs:
              commandArgs[0] === 'status' || commandArgs[0] === 'wake-up'
                ? config.timeoutMs
                : Math.max(config.timeoutMs, 30_000),
          });
        } catch (error) {
          return formatCommandFailure(error, config, commandArgs);
        }
      },
    });

    api.logger.info(
      {
        wakeUpEnabled: config.wakeUpEnabled,
        searchEnabled: config.searchEnabled,
        palacePath: config.palacePath || null,
        sessionExportDir: config.sessionExportDir,
        saveEveryMessages: config.saveEveryMessages,
      },
      'MemPalace memory plugin registered',
    );
  },
};
