import crypto from 'node:crypto';
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

function timingSafeEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isAuthorizedWebhook(req, config) {
  const secret = String(config.webhookSecret || '').trim();
  if (!secret) return false;
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && timingSafeEquals(match[1], secret));
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
        const pendingState = await pending.get(context.sessionId);

        if (context.isInteractiveSource && pendingState) {
          if (pendingState.userId && pendingState.userId !== context.userId) {
            return {
              action: 'block',
              reason:
                'Only the requesting user can respond to this concierge prompt.',
            };
          }
          const chosenProfile = parseConciergeChoice(context.requestContent);
          if (!chosenProfile) {
            return {
              action: 'block',
              reason: buildConciergeQuestion({ invalidChoice: true }),
              metadata: responseMetadata(context),
            };
          }
          await pending.delete(context.sessionId);
          return {
            action: 'transform',
            payload: pendingState.originalUserContent,
            reason: 'Concierge urgency selection applied.',
            metadata: buildRoutingMetadata(config, {
              profile: chosenProfile,
              currentModel: context.currentModel || context.model,
              originalUserContent: pendingState.originalUserContent,
              effectiveUserTurnContent: pendingState.originalUserContent,
              effectiveUserTurnContentStripped:
                pendingState.originalUserContent,
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

        await pending.set(context.sessionId, {
          originalUserContent: content,
          createdAt: new Date().toISOString(),
          media: cloneMedia(context.media),
          userId: context.userId || '',
          channelId: context.channelId || '',
          agentId: context.agentId || '',
          chatbotId: context.chatbotId || '',
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
          if (!isAuthorizedWebhook(req, config)) {
            sendJson(res, 403, {
              error: 'Concierge webhook authorization failed.',
            });
            return;
          }
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId || '').trim();
          const profile = parseConciergeChoice(body.profile);
          const userId = String(body.userId || '').trim();
          const rawChannelId =
            typeof body.channelId === 'string' ? body.channelId.trim() : '';
          const channelId = rawChannelId || 'web';
          if (!sessionId || !profile || !userId) {
            sendJson(res, 400, {
              error: 'sessionId, userId, and profile are required.',
            });
            return;
          }
          const pendingState = await pending.get(sessionId);
          if (!pendingState) {
            sendJson(res, 409, {
              error: 'No pending concierge prompt exists for this session.',
            });
            return;
          }
          if (pendingState.userId && pendingState.userId !== userId) {
            sendJson(res, 403, {
              error:
                'Only the requesting user can respond to this concierge prompt.',
            });
            return;
          }
          if (
            pendingState.channelId &&
            rawChannelId &&
            pendingState.channelId !== rawChannelId
          ) {
            sendJson(res, 403, {
              error: 'Concierge prompt channel mismatch.',
            });
            return;
          }
          const result = await api.dispatchInboundMessage({
            sessionId,
            sessionMode: 'resume',
            guildId: typeof body.guildId === 'string' ? body.guildId : null,
            channelId: pendingState.channelId || channelId,
            userId,
            username: typeof body.username === 'string' ? body.username : null,
            content: profile,
            agentId:
              pendingState.agentId ||
              (typeof body.agentId === 'string' ? body.agentId : null),
            chatbotId:
              pendingState.chatbotId ||
              (typeof body.chatbotId === 'string' ? body.chatbotId : null),
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
