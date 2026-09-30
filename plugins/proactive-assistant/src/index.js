/**
 * Proactive Assistant: lets the connected HybridAI account's mail and
 * calendar produce suggestions while no conversation is running.
 *
 * This file only wires the gateway to `feed.js`: the `proactive` command the
 * user's app calls through chat, and the timer that looks at the account.
 * Assessment is a model request without tools; a suggestion is a draft the
 * user reviews, never an action.
 */
import { createFeed } from './feed.js';
import { createPlatform } from './platform.js';
import { createStore } from './store.js';

// 5 minutes (engineering choice, 2026-09-30): bounds how long after a mail
// arrives its suggestion can appear. Polling, not Gmail push, which would
// need a Pub/Sub topic and a public webhook per gateway.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function defaultAssistantName(config) {
  const id = config.agents?.defaultAgentId || 'main';
  const agent = (config.agents?.list || []).find((entry) => entry.id === id);
  return agent?.displayName || agent?.name || 'HybridClaw';
}

export default {
  id: 'proactive-assistant',
  kind: 'tool',
  register(api) {
    const getApiKey = () => api.getCredential('HYBRIDAI_API_KEY') || '';
    const check = () =>
      void feed
        .check()
        .catch((error) =>
          api.logger.error(
            { errorType: error?.name },
            'Proactive check did not finish.',
          ),
        );
    const feed = createFeed({
      store: createStore(api.runtime.homeDir, api.logger),
      platform: createPlatform({
        baseUrl: api.config.hybridai?.baseUrl,
        getApiKey,
      }),
      getApiKey,
      async assess(messages) {
        const result = await api.callAuxiliaryModel({
          agentId: api.config.agents?.defaultAgentId || 'main',
          messages,
          tools: [],
          fallbackEnableRag: false,
          maxTokens: 4000,
          temperature: 0,
          timeoutMs: 60_000,
          traceReason: 'proactive-assessment',
        });
        return result.content;
      },
      assistantName: defaultAssistantName(api.config),
      logger: api.logger,
      // Takes the mailbox bookmark right away instead of at the next tick.
      onSwitchedOn: check,
    });

    api.registerCommand({
      name: 'proactive',
      description: 'Suggestions from your mail and calendar (used by the app)',
      handler: (args, context) => feed.command(args, context),
    });

    let timer;
    api.registerService({
      id: 'watch',
      async start() {
        timer = setInterval(check, CHECK_INTERVAL_MS);
        timer.unref();
      },
      async stop() {
        clearInterval(timer);
      },
    });
  },
};
