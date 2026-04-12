import { resolveGbrainPluginConfig } from './config.js';
import {
  buildGbrainPromptContextResult,
  buildGbrainStatusText,
  discoverGbrainToolsSync,
  runGbrainCommandText,
  runGbrainTool,
} from './gbrain-process.js';

const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
  'OPENAI_API_KEY',
];

function buildGbrainToolName(operationName) {
  return `gbrain_${String(operationName || '').trim()}`;
}

function buildCredentialEnv(api) {
  const credentialEnv = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = api.getCredential(key);
    if (typeof value === 'string' && value.trim()) {
      credentialEnv[key] = value.trim();
    }
  }
  return credentialEnv;
}

function registerDiscoveredTools(api, config) {
  const registeredToolNames = [];

  try {
    const discoveredTools = discoverGbrainToolsSync(config);
    for (const tool of discoveredTools) {
      const toolName = buildGbrainToolName(tool.operationName);
      api.registerTool({
        name: toolName,
        description: `${tool.description} (via gbrain ${tool.operationName})`,
        parameters: tool.parameters,
        async handler(args) {
          return await runGbrainTool(tool.operationName, args, config);
        },
      });
      registeredToolNames.push(toolName);
    }
  } catch (error) {
    api.logger.warn(
      {
        command: config.command,
        error,
        workingDirectory: config.workingDirectory,
      },
      'Failed to discover gbrain tools during plugin registration',
    );
  }

  return registeredToolNames;
}

function renderGbrainGuide(registeredToolNames) {
  const toolNames = new Set(registeredToolNames);
  if (!toolNames.has('gbrain_query') && !toolNames.has('gbrain_search')) {
    return null;
  }

  const guidance = [
    'GBrain plugin guide:',
    '- Use `gbrain_query` for open-ended factual recall against the external knowledge brain.',
    '- Use `gbrain_search` for exact names, terms, or narrow lexical probes.',
  ];

  if (toolNames.has('gbrain_get_page')) {
    guidance.push(
      '- After a promising hit, use `gbrain_get_page` to read the full page before making strong claims.',
    );
  }
  if (toolNames.has('gbrain_get_backlinks')) {
    guidance.push(
      '- Use `gbrain_get_backlinks` to inspect who or what else references the same entity.',
    );
  }
  if (toolNames.has('gbrain_get_timeline')) {
    guidance.push(
      '- Use `gbrain_get_timeline` when the user asks what changed over time.',
    );
  }
  if (
    toolNames.has('gbrain_put_page') ||
    toolNames.has('gbrain_add_link') ||
    toolNames.has('gbrain_add_timeline_entry')
  ) {
    guidance.push(
      '- Use the prefixed write tools to keep the brain current when the user wants durable knowledge updates.',
    );
  }
  if (toolNames.has('gbrain_sync_brain')) {
    guidance.push(
      '- Use `gbrain_sync_brain` after the underlying markdown repo changes and the search index needs refreshing.',
    );
  }
  guidance.push(
    '- GBrain stores world knowledge. HybridClaw built-in memory remains the place for operational preferences and session-local instructions.',
  );

  return guidance.join('\n');
}

function buildCommandFailureText(config, args, error) {
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error');
  return [
    args.length === 0 || String(args[0]).toLowerCase() === 'status'
      ? 'GBrain is unavailable.'
      : 'GBrain command failed.',
    `Command: ${config.command}`,
    `Working directory: ${config.workingDirectory}`,
    ...(args.length > 0 ? [`Arguments: ${args.join(' ')}`] : []),
    '',
    message,
  ].join('\n');
}

export default {
  id: 'gbrain',
  kind: 'memory',
  register(api) {
    const config = Object.freeze({
      ...resolveGbrainPluginConfig(api.pluginConfig, api.runtime),
      credentialEnv: buildCredentialEnv(api),
    });

    const registeredToolNames = registerDiscoveredTools(api, config);

    api.registerMemoryLayer({
      id: 'gbrain-memory-layer',
      priority: 50,
      async start() {
        try {
          await buildGbrainStatusText(config, {
            registeredToolCount: registeredToolNames.length,
          });
          api.logger.debug(
            {
              command: config.command,
              workingDirectory: config.workingDirectory,
            },
            'GBrain startup health-check passed',
          );
        } catch (error) {
          api.logger.warn(
            {
              command: config.command,
              error,
              workingDirectory: config.workingDirectory,
            },
            'GBrain startup health-check failed',
          );
        }
      },
      async getContextForPrompt({ recentMessages }) {
        try {
          const result = await buildGbrainPromptContextResult({
            config,
            recentMessages,
          });
          api.logger.debug(
            {
              resultCount: result.resultCount,
              searchMode: config.searchMode,
              searchQuery: result.searchQuery,
              toolName: result.toolName,
              topResultSlugs: result.topResultSlugs,
              usedFallbackQuery: result.usedFallbackQuery,
              workingDirectory: config.workingDirectory,
            },
            result.promptContext
              ? 'GBrain prompt context injected'
              : 'GBrain prompt search returned no matches',
          );
          return result.promptContext;
        } catch (error) {
          api.logger.warn(
            {
              command: config.command,
              error,
              searchMode: config.searchMode,
              timeoutMs: config.timeoutMs,
              workingDirectory: config.workingDirectory,
            },
            'GBrain prompt search failed',
          );
          return null;
        }
      },
    });

    api.registerPromptHook({
      id: 'gbrain-guide',
      priority: 50,
      render() {
        return renderGbrainGuide(registeredToolNames);
      },
    });

    api.registerCommand({
      name: 'gbrain',
      description:
        'Show GBrain status or pass through GBrain CLI subcommands from the gateway.',
      async handler(args) {
        const normalizedArgs = args
          .map((arg) => String(arg || '').trim())
          .filter(Boolean);

        try {
          if (
            normalizedArgs.length === 0 ||
            normalizedArgs[0].toLowerCase() === 'status'
          ) {
            return await buildGbrainStatusText(config, {
              registeredToolCount: registeredToolNames.length,
            });
          }
          return await runGbrainCommandText(normalizedArgs, config);
        } catch (error) {
          return buildCommandFailureText(config, normalizedArgs, error);
        }
      },
    });

    api.logger.info(
      {
        command: config.command,
        registeredToolCount: registeredToolNames.length,
        searchMode: config.searchMode,
        workingDirectory: config.workingDirectory,
      },
      'GBrain plugin registered',
    );
  },
};
