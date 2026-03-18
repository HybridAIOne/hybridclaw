import { Honcho } from '@honcho-ai/sdk';
import type {
  HybridClawPluginApi,
  HybridClawPluginDefinition,
  MemoryLayerPlugin,
} from '@hybridaione/hybridclaw/plugin-sdk';

interface HonchoPluginConfig {
  workspaceId: string;
  environment: string;
  autoCapture: boolean;
  autoRecall: boolean;
  contextQuery: string;
}

type HonchoMessagePeer = {
  message: (content: string) => unknown;
  chat: (prompt: string) => Promise<string>;
};

type HonchoSessionState = {
  session: {
    addPeers: (peers: unknown[]) => Promise<void>;
    addMessages: (messages: unknown[]) => Promise<void>;
  };
  userPeer: HonchoMessagePeer;
  agentPeer: HonchoMessagePeer;
};

export default {
  id: 'honcho-memory',
  kind: 'memory',

  register(api: HybridClawPluginApi) {
    const cfg = api.pluginConfig as HonchoPluginConfig;
    const apiKey = api.getCredential('HONCHO_API_KEY');
    if (!apiKey) {
      api.logger.error('HONCHO_API_KEY not set; plugin disabled');
      return;
    }

    const environment = String(cfg.environment || '').trim().toLowerCase();
    const baseUrl =
      environment.includes('://')
        ? cfg.environment
        : environment === 'production'
          ? 'https://api.honcho.dev'
          : environment === 'demo'
            ? 'https://demo.honcho.dev'
            : cfg.environment;

    const client = new Honcho({
      workspaceId: cfg.workspaceId,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    });

    const peerCache = new Map<string, Promise<HonchoMessagePeer>>();
    const sessionCache = new Map<string, Promise<HonchoSessionState>>();

    async function getPeer(id: string): Promise<HonchoMessagePeer> {
      const cacheKey = String(id || '').trim();
      if (!cacheKey) {
        throw new Error('Honcho peer id is required.');
      }
      if (!peerCache.has(cacheKey)) {
        peerCache.set(
          cacheKey,
          client.peer(cacheKey) as Promise<HonchoMessagePeer>,
        );
      }
      return peerCache.get(cacheKey) as Promise<HonchoMessagePeer>;
    }

    async function getSessionState(
      sessionId: string,
      userId: string,
      agentId: string,
    ): Promise<HonchoSessionState> {
      const cacheKey = String(sessionId || '').trim();
      if (!cacheKey) {
        throw new Error('Honcho session id is required.');
      }
      if (!sessionCache.has(cacheKey)) {
        sessionCache.set(
          cacheKey,
          (async () => {
            const session = await client.session(cacheKey);
            const userPeer = await getPeer(userId);
            const agentPeer = await getPeer(agentId);
            await session.addPeers([userPeer, agentPeer]);
            return { session, userPeer, agentPeer };
          })(),
        );
      }
      return sessionCache.get(cacheKey) as Promise<HonchoSessionState>;
    }

    const layer: MemoryLayerPlugin = {
      id: 'honcho-memory',
      priority: 100,

      async getContextForPrompt({ userId }) {
        if (!cfg.autoRecall) return null;
        try {
          const peer = await getPeer(userId);
          return await peer.chat(cfg.contextQuery);
        } catch (error) {
          api.logger.warn({ error }, 'Honcho recall failed');
          return null;
        }
      },

      async onTurnComplete({ sessionId, userId, agentId, messages }) {
        if (!cfg.autoCapture) return;
        try {
          const state = await getSessionState(sessionId, userId, agentId);
          const honchoMessages = messages
            .filter(
              (message) =>
                message.role === 'user' || message.role === 'assistant',
            )
            .map((message) =>
              message.role === 'user'
                ? state.userPeer.message(message.content)
                : state.agentPeer.message(message.content),
            );
          if (honchoMessages.length === 0) return;
          await state.session.addMessages(honchoMessages);
        } catch (error) {
          api.logger.warn({ error }, 'Honcho capture failed');
        }
      },
    };

    api.registerMemoryLayer(layer);
    api.registerTool({
      name: 'honcho_query',
      description:
        "Query Honcho's reasoning about a user and return a natural-language summary.",
      parameters: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The user to query about.',
          },
          question: {
            type: 'string',
            description: 'What to ask Honcho about the user.',
          },
        },
        required: ['user_id', 'question'],
      },
      async handler(args) {
        const userId = String(args.user_id || '').trim();
        const question = String(args.question || '').trim();
        if (!userId || !question) {
          throw new Error('honcho_query requires non-empty user_id and question.');
        }
        const peer = await getPeer(userId);
        return peer.chat(question);
      },
    });

    api.on('session_reset', async ({ sessionId }) => {
      sessionCache.delete(sessionId);
      api.logger.debug({ sessionId }, 'Honcho session cache cleared');
    });

    api.on('gateway_stop', async () => {
      peerCache.clear();
      sessionCache.clear();
    });

    api.logger.info(
      {
        workspaceId: cfg.workspaceId,
        autoCapture: cfg.autoCapture,
        autoRecall: cfg.autoRecall,
      },
      'Honcho memory plugin registered',
    );
  },
} satisfies HybridClawPluginDefinition;
