import { resolveHonchoPluginConfig } from './config.js';
import { HonchoClient } from './honcho-client.js';
import { HonchoRuntime } from './honcho-runtime.js';

function registerHonchoTools(api, runtime) {
  api.registerTool({
    name: 'honcho_profile',
    description:
      'Inspect Honcho memory for the current session participant and return the current representation and peer card.',
    parameters: {
      type: 'object',
      properties: {
        peer: {
          type: 'string',
          description: 'Which peer to inspect: user or ai.',
          enum: ['user', 'ai'],
        },
      },
      required: [],
    },
    handler(args, context) {
      return runtime.handleToolProfile(args, context);
    },
  });

  api.registerTool({
    name: 'honcho_search',
    description:
      'Search Honcho memory for this session and return relevant representation detail plus matching mirrored messages.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in Honcho memory.',
        },
        peer: {
          type: 'string',
          description: 'Which peer to search about: user or ai.',
          enum: ['user', 'ai'],
        },
      },
      required: ['query'],
    },
    handler(args, context) {
      return runtime.handleToolSearch(args, context);
    },
  });

  api.registerTool({
    name: 'honcho_context',
    description:
      'Ask Honcho a natural-language question about the current user or the AI peer using Honcho reasoning.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The question to ask Honcho.',
        },
        peer: {
          type: 'string',
          description: 'Which peer to reason about: user or ai.',
          enum: ['user', 'ai'],
        },
      },
      required: ['query'],
    },
    handler(args, context) {
      return runtime.handleToolContext(args, context);
    },
  });

  api.registerTool({
    name: 'honcho_conclude',
    description:
      'Save an explicit conclusion about the current user into Honcho memory for future recall.',
    parameters: {
      type: 'object',
      properties: {
        conclusion: {
          type: 'string',
          description: 'The fact or conclusion to store.',
        },
      },
      required: ['conclusion'],
    },
    handler(args, context) {
      return runtime.handleToolConclude(args, context);
    },
  });
}

export default {
  id: 'honcho-memory',
  kind: 'memory',
  register(api) {
    const config = resolveHonchoPluginConfig({
      pluginConfig: api.pluginConfig,
      runtime: api.runtime,
      credentialApiKey: api.getCredential('HONCHO_API_KEY'),
      processEnvApiKey: process.env.HONCHO_API_KEY,
    });
    const client = new HonchoClient(config);
    const runtime = new HonchoRuntime(api, config, client);

    api.registerMemoryLayer({
      id: 'honcho-memory-layer',
      priority: 45,
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
      id: 'honcho-memory-guide',
      priority: 45,
      render(context) {
        return runtime.renderPromptGuide(context);
      },
    });

    api.on('memory_write', (context) => runtime.onMemoryWrite(context), {
      priority: 45,
    });

    api.registerCommand({
      name: 'honcho',
      description:
        'Inspect Honcho sync state, session mappings, identity seeding, and memory recall controls.',
      handler(args, context) {
        return runtime.handleCommand(args, context);
      },
    });

    api.on('session_start', (context) => runtime.onSessionStart(context), {
      priority: 45,
    });
    api.on('session_end', (context) => runtime.onSessionEnd(context), {
      priority: 45,
    });
    api.on('session_reset', (context) => runtime.onSessionReset(context), {
      priority: 45,
    });

    if (config.recallMode !== 'context') {
      registerHonchoTools(api, runtime);
    }

    api.logger.info(
      {
        baseUrl: config.baseUrl,
        workspaceId: config.workspaceId,
        recallMode: config.recallMode,
        writeFrequency: config.writeFrequency,
        sessionStrategy: config.sessionStrategy,
      },
      'Honcho memory plugin registered',
    );
  },
};
