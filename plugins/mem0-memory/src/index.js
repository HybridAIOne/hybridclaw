import { resolveMem0PluginConfig } from './config.js';
import { Mem0Controls } from './mem0-controls.js';
import { Mem0Runtime } from './mem0-runtime.js';

function registerMem0Tools(api, controls) {
  api.registerTool({
    name: 'mem0_profile',
    description: 'Retrieve a broad Mem0 memory snapshot for the current user.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler(args, context) {
      return controls.handleToolProfile(args, context);
    },
  });

  api.registerTool({
    name: 'mem0_search',
    description:
      'Search Mem0 semantic memory for the current user with optional reranking.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in Mem0 memory.',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return.',
        },
        rerank: {
          type: 'boolean',
          description:
            'Whether to rerank search results before returning them.',
        },
      },
      required: ['query'],
    },
    handler(args, context) {
      return controls.handleToolSearch(args, context);
    },
  });

  api.registerTool({
    name: 'mem0_conclude',
    description:
      'Store an explicit durable fact or correction in Mem0 for the current user.',
    parameters: {
      type: 'object',
      properties: {
        conclusion: {
          type: 'string',
          description: 'The durable fact, preference, or correction to store.',
        },
      },
      required: ['conclusion'],
    },
    handler(args, context) {
      return controls.handleToolConclude(args, context);
    },
  });
}

export default {
  id: 'mem0-memory',
  kind: 'memory',
  register(api) {
    const config = resolveMem0PluginConfig({
      pluginConfig: api.pluginConfig,
      runtime: api.runtime,
      credentialApiKey: api.getCredential('MEM0_API_KEY'),
    });
    const runtime = new Mem0Runtime(api, config);
    const controls = new Mem0Controls(runtime);

    api.registerMemoryLayer({
      id: 'mem0-memory-layer',
      priority: 45,
      start() {
        return runtime.start();
      },
      getContextForPrompt(params) {
        return runtime.getContextForPrompt(params);
      },
      onTurnComplete(params) {
        return runtime.onTurnComplete(params);
      },
    });

    api.registerPromptHook({
      id: 'mem0-memory-guide',
      priority: 45,
      render() {
        return runtime.renderPromptGuide();
      },
    });

    api.on('memory_write', (context) => runtime.onMemoryWrite(context), {
      priority: 45,
    });

    api.registerCommand({
      name: 'mem0',
      description:
        'Inspect Mem0 sync state, search saved memories, and store explicit conclusions.',
      handler(args, context) {
        return controls.handleCommand(args, context);
      },
    });

    registerMem0Tools(api, controls);

    api.logger.info(
      {
        host: config.host,
        apiVersion: config.apiVersion,
        searchLimit: config.searchLimit,
        profileLimit: config.profileLimit,
        syncTurns: config.syncTurns,
      },
      'Mem0 memory plugin registered',
    );
  },
};
