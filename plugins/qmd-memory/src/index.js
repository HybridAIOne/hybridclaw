import { resolveQmdPluginConfig } from './config.js';
import { buildQmdPromptContext, buildQmdStatusText } from './qmd-process.js';
import { writeSessionExport } from './session-export.js';

export default {
  id: 'qmd-memory',
  kind: 'memory',
  register(api) {
    const config = resolveQmdPluginConfig(api.pluginConfig, api.runtime);

    api.registerMemoryLayer({
      id: 'qmd-memory-layer',
      priority: 50,
      async getContextForPrompt({ recentMessages }) {
        try {
          return await buildQmdPromptContext({
            config,
            recentMessages,
          });
        } catch (error) {
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
      description: 'Show QMD plugin and index status',
      async handler(args) {
        const subcommand = String(args[0] || 'status').trim().toLowerCase();
        if (subcommand && subcommand !== 'status') {
          return 'Usage: `qmd status`';
        }
        try {
          return await buildQmdStatusText(config);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error || 'unknown');
          return [
            'QMD is unavailable.',
            `Command: ${config.command}`,
            `Working directory: ${config.workingDirectory}`,
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
