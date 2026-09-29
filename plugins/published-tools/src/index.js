import path from 'node:path';
import { resolvePublishedToolsConfig } from './config.js';
import { ConversationStore } from './conversation-store.js';
import { handleMcpPost } from './protocol.js';
import { createToolServer } from './tool-server.js';

const PLUGIN_ID = 'published-tools';
const TOKEN_CREDENTIAL = 'PUBLISHED_TOOLS_TOKEN';

export default {
  id: PLUGIN_ID,
  kind: 'channel',
  register(api) {
    const config = resolvePublishedToolsConfig(api.pluginConfig, api.config);
    const store = new ConversationStore(
      path.join(
        api.runtime.homeDir,
        'data',
        'plugins',
        PLUGIN_ID,
        'conversations.json',
      ),
    );
    const server = {
      allowedOrigins: config.allowedOrigins,
      serverInfo: { name: 'hybridclaw-published-tools', version: '0.1.0' },
      methods: createToolServer({ api, config, store }),
    };
    if (!api.getCredential(TOKEN_CREDENTIAL)) {
      api.logger.warn(
        `${TOKEN_CREDENTIAL} is not set; the MCP endpoint rejects every request.`,
      );
    }

    api.registerInboundWebhook({
      name: 'mcp',
      method: 'POST',
      description: 'MCP endpoint (Streamable HTTP, protocol 2026-07-28)',
      async handler(ctx) {
        // Read per request so a rotated secret applies without a reload.
        await handleMcpPost(ctx, {
          ...server,
          token: api.getCredential(TOKEN_CREDENTIAL),
        });
      },
    });
  },
};
