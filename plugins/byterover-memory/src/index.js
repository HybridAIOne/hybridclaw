import {
  latestMessageByRole,
  normalizeText,
  toTrimmedString,
  truncateText,
} from '@hybridaione/hybridclaw/plugin-sdk';
import { runByteRoverCommandText } from './byterover-process.js';
import { resolveByteRoverPluginConfig } from './config.js';

const MIN_QUERY_CHARS = 10;
const MIN_RESULT_CHARS = 20;
const MAX_QUERY_CHARS = 5000;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_TURN_MESSAGE_CHARS = 2000;
const MAX_COMPACTION_MESSAGE_CHARS = 500;
const MAX_COMPACTION_MESSAGES = 10;

function normalizeSearchQuery(value) {
  const normalized = toTrimmedString(value).replace(/\s+/g, ' ');
  if (normalized.length < MIN_QUERY_CHARS) return '';
  return truncateText(normalized, MAX_QUERY_CHARS);
}

function stripMatchingQuotes(value) {
  const normalized = toTrimmedString(value);
  if (normalized.length < 2) return normalized;
  const first = normalized[0];
  const last = normalized.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function getLatestUserQuery(recentMessages) {
  return normalizeSearchQuery(
    latestMessageByRole(recentMessages, 'user')?.content,
  );
}

function buildQueryArgs(query) {
  return ['query', '--', query];
}

function buildCurateArgs(content) {
  return ['curate', '--', content];
}

function describeMemoryFile(memoryFilePath) {
  if (memoryFilePath === 'USER.md') return 'User profile';
  if (memoryFilePath === 'MEMORY.md') return 'Durable memory';
  return `Daily memory note (${memoryFilePath})`;
}

function resolveMirroredMemoryContent(context) {
  if (context.action === 'append' || context.action === 'write') {
    return toTrimmedString(context.content);
  }
  if (context.action === 'replace') {
    return toTrimmedString(context.newText);
  }
  return '';
}

function buildMemoryWriteCurateContent(context) {
  const content = resolveMirroredMemoryContent(context);
  if (!content) return '';
  return `[${describeMemoryFile(context.memoryFilePath)}]\n${content}`;
}

function buildTurnCurateContent(messages) {
  const userMessage = latestMessageByRole(messages, 'user');
  const assistantMessage = latestMessageByRole(messages, 'assistant');
  const userContent = toTrimmedString(userMessage?.content);
  if (userContent.length < MIN_QUERY_CHARS) return '';
  const assistantContent = toTrimmedString(assistantMessage?.content);
  const lines = [`User: ${truncateText(userContent, MAX_TURN_MESSAGE_CHARS)}`];
  if (assistantContent) {
    lines.push(
      `Assistant: ${truncateText(assistantContent, MAX_TURN_MESSAGE_CHARS)}`,
    );
  }
  return lines.join('\n');
}

function buildCompactionCurateContent(summary, olderMessages) {
  const sections = ['[Pre-compaction context]'];
  const normalizedSummary = toTrimmedString(summary);
  if (normalizedSummary) {
    sections.push('');
    sections.push('Summary:');
    sections.push(truncateText(normalizedSummary, 1500));
  }

  const excerpts = (olderMessages || [])
    .filter((message) => {
      const role = String(message?.role || '').toLowerCase();
      if (role !== 'user' && role !== 'assistant') return false;
      return toTrimmedString(message?.content).length > 0;
    })
    .slice(-MAX_COMPACTION_MESSAGES)
    .map((message) => {
      const role = String(message.role || '').toLowerCase();
      const content = truncateText(
        message.content,
        MAX_COMPACTION_MESSAGE_CHARS,
      );
      return `${role}: ${content}`;
    });

  if (excerpts.length === 0 && !normalizedSummary) return '';
  if (excerpts.length > 0) {
    sections.push('');
    sections.push(...excerpts);
  }
  return sections.join('\n');
}

function normalizeManualCommandArgs(args) {
  const normalizedArgs = Array.isArray(args)
    ? args.map((arg) => String(arg || '').trim()).filter(Boolean)
    : [];
  if (normalizedArgs.length === 0) {
    return ['status'];
  }
  const command = normalizedArgs[0].toLowerCase();
  if (
    (command === 'query' || command === 'curate') &&
    !normalizedArgs.includes('--')
  ) {
    const payload = stripMatchingQuotes(normalizedArgs.slice(1).join(' '));
    return payload ? [command, '--', payload] : [command];
  }
  return [command, ...normalizedArgs.slice(1)];
}

function timeoutForCommand(command, config) {
  const normalized = toTrimmedString(command).toLowerCase();
  if (normalized === 'status' || normalized === 'query') {
    return config.queryTimeoutMs;
  }
  if (normalized === 'curate') {
    return config.curateTimeoutMs;
  }
  return Math.max(config.queryTimeoutMs, config.curateTimeoutMs);
}

function buildStatusText(output, config, apiKey) {
  return [
    `Command: ${config.command}`,
    `Working directory: ${config.workingDirectory}`,
    `BRV_API_KEY: ${apiKey ? 'configured' : 'unset (optional)'}`,
    '',
    output,
  ].join('\n');
}

function formatCommandFailure(error, config, args) {
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error');
  return [
    'ByteRover command failed.',
    `Command: ${config.command}`,
    `Working directory: ${config.workingDirectory}`,
    ...(args.length > 0 ? [`Arguments: ${args.join(' ')}`] : []),
    '',
    message,
  ].join('\n');
}

function createByteRoverRuntime(api, config) {
  let queue = Promise.resolve();

  function getApiKey() {
    return toTrimmedString(api.getCredential('BRV_API_KEY'));
  }

  async function runQuery(query, maxChars = MAX_TOOL_RESULT_CHARS) {
    return await runByteRoverCommandText(buildQueryArgs(query), config, {
      apiKey: getApiKey(),
      timeoutMs: config.queryTimeoutMs,
      maxChars,
    });
  }

  async function runCurate(content) {
    return await runByteRoverCommandText(buildCurateArgs(content), config, {
      apiKey: getApiKey(),
      timeoutMs: config.curateTimeoutMs,
      maxChars: 2000,
    });
  }

  function enqueueCurate(params) {
    const { reason, sessionId, content } = params;
    if (!toTrimmedString(content)) {
      return queue.catch(() => undefined);
    }
    const task = queue
      .catch(() => undefined)
      .then(async () => {
        try {
          const output = await runCurate(content);
          api.logger.debug(
            {
              reason,
              sessionId,
              workingDirectory: config.workingDirectory,
              output: truncateText(normalizeText(output), 240),
            },
            'ByteRover curate completed',
          );
        } catch (error) {
          api.logger.warn(
            {
              error,
              reason,
              sessionId,
              workingDirectory: config.workingDirectory,
            },
            'ByteRover curate failed',
          );
        }
      });
    queue = task;
    return task;
  }

  return {
    start() {
      // Fire-and-forget: don't block gateway startup for the health check.
      // ByteRover queries involve LLM calls and can take 10-30s.
      void runByteRoverCommandText(['status'], config, {
        apiKey: getApiKey(),
        timeoutMs: Math.min(config.queryTimeoutMs, 15_000),
        maxChars: 2000,
      }).then(
        (output) => {
          api.logger.debug(
            {
              command: config.command,
              workingDirectory: config.workingDirectory,
              output: truncateText(normalizeText(output), 240),
            },
            'ByteRover startup health-check passed',
          );
        },
        (error) => {
          api.logger.warn(
            {
              error,
              command: config.command,
              workingDirectory: config.workingDirectory,
            },
            'ByteRover startup health-check failed',
          );
        },
      );
    },
    async stop() {
      await queue.catch(() => undefined);
    },
    async getContextForPrompt({ recentMessages }) {
      const query = getLatestUserQuery(recentMessages);
      if (!query) return null;
      try {
        const output = await runQuery(query, config.maxInjectedChars);
        if (toTrimmedString(output).length < MIN_RESULT_CHARS) {
          return null;
        }
        return truncateText(
          normalizeText(
            [
              'ByteRover recalled context for the latest user message:',
              `Query: ${query}`,
              '',
              output,
            ].join('\n'),
          ),
          config.maxInjectedChars,
        );
      } catch (error) {
        api.logger.warn(
          {
            error,
            query,
            workingDirectory: config.workingDirectory,
          },
          'ByteRover prompt recall failed',
        );
        return null;
      }
    },
    renderPromptGuide() {
      return [
        'ByteRover memory tools are enabled.',
        'Use `brv_query` when prior project decisions, preferences, or patterns may matter.',
        'Use `brv_curate` to save durable facts, corrections, or workflows worth keeping across sessions.',
        'Use `brv_status` or `/byterover status` to inspect CLI health and the working directory.',
      ].join('\n');
    },
    onTurnComplete(params) {
      if (!config.autoCurate) return;
      const content = buildTurnCurateContent(params.messages);
      void enqueueCurate({
        sessionId: params.sessionId,
        reason: 'turn complete',
        content,
      });
    },
    onMemoryWrite(context) {
      if (!config.mirrorMemoryWrites) return;
      const content = buildMemoryWriteCurateContent(context);
      if (!content) return;
      void enqueueCurate({
        sessionId: context.sessionId,
        reason: `memory write ${context.action}`,
        content,
      });
    },
    async onBeforeCompaction(context) {
      const content = buildCompactionCurateContent(
        context.summary,
        context.olderMessages,
      );
      await enqueueCurate({
        sessionId: context.sessionId,
        reason: 'before compaction',
        content,
      });
    },
    async handleToolStatus() {
      try {
        const output = await runByteRoverCommandText(['status'], config, {
          apiKey: getApiKey(),
          timeoutMs: timeoutForCommand('status', config),
          maxChars: MAX_TOOL_RESULT_CHARS,
        });
        return buildStatusText(output, config, getApiKey());
      } catch (error) {
        return formatCommandFailure(error, config, ['status']);
      }
    },
    async handleToolQuery(args) {
      const query = normalizeSearchQuery(args?.query);
      if (!query) {
        return 'Error: query is required.';
      }
      try {
        const output = await runQuery(query);
        if (toTrimmedString(output).length < MIN_RESULT_CHARS) {
          return 'No relevant ByteRover memories found.';
        }
        return output;
      } catch (error) {
        return formatCommandFailure(error, config, ['query', '--', query]);
      }
    },
    async handleToolCurate(args) {
      const content = toTrimmedString(args?.content);
      if (!content) {
        return 'Error: content is required.';
      }
      try {
        await runCurate(content);
        return 'ByteRover memory updated.';
      } catch (error) {
        return formatCommandFailure(error, config, ['curate', '--', content]);
      }
    },
    async handleCommand(args) {
      const commandArgs = normalizeManualCommandArgs(args);
      try {
        const output = await runByteRoverCommandText(commandArgs, config, {
          apiKey: getApiKey(),
          timeoutMs: timeoutForCommand(commandArgs[0], config),
          maxChars: MAX_TOOL_RESULT_CHARS,
        });
        if (commandArgs[0] === 'status') {
          return buildStatusText(output, config, getApiKey());
        }
        return output;
      } catch (error) {
        return formatCommandFailure(error, config, commandArgs);
      }
    },
  };
}

export default {
  id: 'byterover-memory',
  kind: 'memory',
  register(api) {
    const config = resolveByteRoverPluginConfig(api.pluginConfig, api.runtime);
    const runtime = createByteRoverRuntime(api, config);

    api.registerMemoryLayer({
      id: 'byterover-memory-layer',
      priority: 48,
      start() {
        return runtime.start();
      },
      stop() {
        return runtime.stop();
      },
      getContextForPrompt(params) {
        return runtime.getContextForPrompt(params);
      },
      onTurnComplete(params) {
        return runtime.onTurnComplete(params);
      },
    });

    api.registerPromptHook({
      id: 'byterover-memory-guide',
      priority: 48,
      render() {
        return runtime.renderPromptGuide();
      },
    });

    api.registerTool({
      name: 'brv_status',
      description:
        'Check ByteRover CLI health, working-directory state, and optional API-key availability.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler() {
        return runtime.handleToolStatus();
      },
    });

    api.registerTool({
      name: 'brv_query',
      description:
        'Search ByteRover persistent memory for relevant project knowledge, preferences, or past decisions.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in ByteRover memory.',
          },
        },
        required: ['query'],
      },
      handler(args) {
        return runtime.handleToolQuery(args);
      },
    });

    api.registerTool({
      name: 'brv_curate',
      description:
        'Store a durable fact, decision, preference, or pattern in ByteRover memory.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to save into ByteRover.',
          },
        },
        required: ['content'],
      },
      handler(args) {
        return runtime.handleToolCurate(args);
      },
    });

    api.registerCommand({
      name: 'byterover',
      description: 'Run ByteRover CLI commands (defaults to status).',
      handler(args) {
        return runtime.handleCommand(args);
      },
    });

    api.on('memory_write', (context) => runtime.onMemoryWrite(context), {
      priority: 48,
    });

    api.on(
      'before_compaction',
      async (context) => {
        await runtime.onBeforeCompaction(context);
      },
      { priority: 48 },
    );

    api.logger.info(
      {
        workingDirectory: config.workingDirectory,
        autoCurate: config.autoCurate,
        mirrorMemoryWrites: config.mirrorMemoryWrites,
        maxInjectedChars: config.maxInjectedChars,
      },
      'ByteRover memory plugin registered',
    );
  },
};
