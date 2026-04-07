import { resolveMempalacePluginConfig } from './config.js';
import {
  cleanSearchText,
  cleanWakeUpText,
  runMempalace,
  runMempalaceCommandText,
} from './mempalace-process.js';

function truncateText(value, maxChars) {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
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
  const content = String(latestMessage?.content || '').trim();
  return content.length >= 3 ? content : '';
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
      },
      'MemPalace memory plugin registered',
    );
  },
};
