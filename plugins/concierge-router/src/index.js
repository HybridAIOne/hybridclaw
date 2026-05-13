import { createConciergeCommandHandler } from './command.js';
import {
  buildConciergeChoiceComponents,
  buildConciergeQuestion,
  buildRoutingMetadata,
  createPendingStore,
  decideConciergeRouting,
  inferPromptUrgencyProfile,
  parseConciergeChoice,
  resolveConciergeConfig,
  shouldTriggerConcierge,
} from './routing.js';

function cloneMedia(media) {
  return Array.isArray(media) ? structuredClone(media) : [];
}

function getRoutingText(context) {
  return String(context.userContent || context.requestContent || '').trim();
}

function responseMetadata(context) {
  return {
    conciergeRouter: {
      components:
        context.source === 'discord' && context.userId
          ? buildConciergeChoiceComponents({
              sessionId: context.sessionId,
              userId: context.userId,
            })
          : undefined,
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  return text ? JSON.parse(text) : {};
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

export default {
  id: 'concierge-router',
  kind: 'middleware',
  register(api) {
    let config = resolveConciergeConfig(api);
    const pending = createPendingStore(api);

    api.registerMiddleware({
      id: 'urgency-router',
      priority: 0,
      async routing(context) {
        const content = getRoutingText(context);
        const pendingState = pending.get(context.sessionId);

        if (context.isInteractiveSource && pendingState) {
          const chosenProfile = parseConciergeChoice(context.requestContent);
          if (!chosenProfile) {
            return {
              action: 'block',
              reason: buildConciergeQuestion({ invalidChoice: true }),
              metadata: responseMetadata(context),
            };
          }
          pending.delete(context.sessionId);
          return {
            action: 'transform',
            payload: pendingState.originalUserContent,
            reason: 'Concierge urgency selection applied.',
            metadata: buildRoutingMetadata(config, {
              profile: chosenProfile,
              currentModel: context.currentModel || context.model,
              originalUserContent: pendingState.originalUserContent,
              effectiveUserTurnContent: pendingState.originalUserContent,
              effectiveUserTurnContentStripped: pendingState.originalUserContent,
              media: cloneMedia(pendingState.media),
            }),
          };
        }

        if (
          context.isInteractiveSource &&
          parseConciergeChoice(context.requestContent) &&
          String(context.requestContent || '').trim().length <= 32
        ) {
          return {
            action: 'block',
            reason: 'This concierge prompt has expired or was already handled.',
          };
        }

        if (
          !context.isInteractiveSource ||
          !config.enabled ||
          context.explicitModelPinned
        ) {
          return { action: 'allow' };
        }

        const inferredProfile = inferPromptUrgencyProfile(content);
        if (inferredProfile) {
          return {
            action: 'transform',
            payload: content,
            reason: 'Concierge urgency inferred from prompt.',
            metadata: buildRoutingMetadata(config, {
              profile: inferredProfile,
              currentModel: context.currentModel || context.model,
              originalUserContent: content,
              effectiveUserTurnContent: content,
              effectiveUserTurnContentStripped: content,
              media: cloneMedia(context.media),
            }),
          };
        }

        if (
          !shouldTriggerConcierge(content, {
            explicitModelPinned: context.explicitModelPinned,
            interactiveOnly: context.isInteractiveSource,
          })
        ) {
          return { action: 'allow' };
        }

        const decision = await decideConciergeRouting(api, config, {
          content,
          agentId: context.agentId,
          chatbotId: context.chatbotId,
        });
        if (decision.kind === 'pick_profile') {
          return {
            action: 'transform',
            payload: content,
            reason: 'Concierge urgency selected by classifier.',
            metadata: buildRoutingMetadata(config, {
              profile: decision.profile,
              currentModel: context.currentModel || context.model,
              originalUserContent: content,
              effectiveUserTurnContent: content,
              effectiveUserTurnContentStripped: content,
              media: cloneMedia(context.media),
            }),
          };
        }

        pending.set(context.sessionId, {
          originalUserContent: content,
          createdAt: new Date().toISOString(),
          media: cloneMedia(context.media),
        });
        return {
          action: 'block',
          reason: buildConciergeQuestion(),
          metadata: responseMetadata(context),
        };
      },
    });

    api.registerCommand({
      name: 'concierge',
      description: 'Inspect or configure concierge routing defaults',
      handler: createConciergeCommandHandler(
        api,
        () => config,
        (nextConfig) => {
          config = nextConfig;
        },
      ),
    });

    api.registerInboundWebhook({
      name: 'choice',
      method: 'POST',
      description: 'Handle concierge urgency button callbacks',
      async handler({ req, res }) {
        try {
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId || '').trim();
          const profile = parseConciergeChoice(body.profile);
          const userId = String(body.userId || '').trim();
          const channelId = String(body.channelId || 'web').trim();
          if (!sessionId || !profile || !userId) {
            sendJson(res, 400, {
              error: 'sessionId, userId, and profile are required.',
            });
            return;
          }
          const result = await api.dispatchInboundMessage({
            sessionId,
            sessionMode: 'resume',
            guildId: typeof body.guildId === 'string' ? body.guildId : null,
            channelId,
            userId,
            username:
              typeof body.username === 'string' ? body.username : null,
            content: profile,
            agentId:
              typeof body.agentId === 'string' ? body.agentId : null,
            chatbotId:
              typeof body.chatbotId === 'string' ? body.chatbotId : null,
          });
          sendJson(res, 200, { ok: true, result });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.logger.info(
      {
        enabled: config.enabled,
        model: config.model,
      },
      'concierge-router plugin registered',
    );
  },
};
