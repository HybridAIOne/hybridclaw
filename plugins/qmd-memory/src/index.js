import { resolveQmdPluginConfig } from './config.js';
import {
  buildQmdPromptContextResult,
  buildQmdStatusText,
  runQmd,
  runQmdCommandText,
} from './qmd-process.js';
import { writeSessionExport } from './session-export.js';

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

export default {
  id: 'qmd-memory',
  kind: 'memory',
  register(api) {
    const config = resolveQmdPluginConfig(api.pluginConfig, api.runtime);

    api.registerMemoryLayer({
      id: 'qmd-memory-layer',
      priority: 50,
      async start() {
        try {
          const result = await runQmd(['status'], config);
          if (!result.ok) {
            throw result.error;
          }
          api.logger.debug(
            {
              command: config.command,
              workingDirectory: config.workingDirectory,
            },
            'QMD startup health-check passed',
          );
        } catch (error) {
          api.logger.warn(
            {
              error,
              command: config.command,
              workingDirectory: config.workingDirectory,
            },
            'QMD startup health-check failed',
          );
        }
      },
      async getContextForPrompt({ recentMessages, abortSignal }) {
        try {
          const result = await buildQmdPromptContextResult({
            config,
            recentMessages,
            abortSignal,
          });
          api.logger.debug(
            {
              searchMode: config.searchMode,
              workingDirectory: config.workingDirectory,
              resultCount: result.resultCount,
              usedFallbackQuery: result.usedFallbackQuery,
              topResultPaths: result.topResultPaths,
            },
            result.promptContext
              ? 'QMD prompt context injected'
              : 'QMD prompt search returned no matches',
          );
          return result.promptContext;
        } catch (error) {
          if (abortSignal?.aborted || isAbortError(error)) {
            api.logger.debug(
              {
                searchMode: config.searchMode,
                workingDirectory: config.workingDirectory,
              },
              'QMD prompt search aborted',
            );
            return null;
          }
          api.logger.warn(
            {
              error,
              searchMode: config.searchMode,
              workingDirectory: config.workingDirectory,
            },
            'QMD prompt search failed',
          );
          return null;
        }
      },
      async onTurnComplete({ sessionId, userId, agentId, messages }) {
        if (!config.sessionExport) return;
        try {
          const filePath = await writeSessionExport({
            exportDir: config.sessionExportDir,
            sessionId,
            userId,
            agentId,
            messages,
          });
          api.logger.debug(
            {
              filePath,
              sessionId,
            },
            'QMD session transcript exported',
          );
        } catch (error) {
          api.logger.warn(
            {
              error,
              sessionId,
              exportDir: config.sessionExportDir,
            },
            'QMD session export failed',
          );
        }
      },
    });

    api.registerCommand({
      name: 'qmd',
      description: 'Run QMD CLI commands (defaults to status)',
      async handler(args) {
        const normalizedArgs = args
          .map((arg) => String(arg || '').trim())
          .filter(Boolean);
        const subcommand = String(normalizedArgs[0] || 'status')
          .trim()
          .toLowerCase();
        try {
          if (subcommand === 'status') {
            return await buildQmdStatusText(config);
          }
          return await runQmdCommandText(normalizedArgs, config);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error || 'unknown');
          return [
            subcommand === 'status'
              ? 'QMD is unavailable.'
              : 'QMD command failed.',
            `Command: ${config.command}`,
            `Working directory: ${config.workingDirectory}`,
            ...(normalizedArgs.length > 0
              ? [`Arguments: ${normalizedArgs.join(' ')}`]
              : []),
            '',
            message,
          ].join('\n');
        }
      },
    });

    api.logger.info(
      {
        searchMode: config.searchMode,
        workingDirectory: config.workingDirectory,
        sessionExport: config.sessionExport,
      },
      'QMD memory plugin registered',
    );
  },
};
