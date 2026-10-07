/**
 * Optional cloud change relay. Only configured binding IDs and opaque event IDs
 * are accepted; operator configuration fixes the user, source and policy.
 * The host scheduler supplies durable deduplication, debounce and quiet hours.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '@hybridaione/hybridclaw/plugin-sdk';

function authenticated(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !token) return false;
  const candidate = header.match(/^Bearer (\S+)$/)?.[1];
  if (!candidate) return false;
  const supplied = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export default {
  id: 'connector-events',
  kind: 'channel',
  register(api) {
    const bindings = new Map();
    const owner = api.pluginConfig.ownerUserId;
    if (owner !== undefined) {
      if (typeof owner !== 'string' || !owner.trim() || owner.length > 200)
        throw new Error('Invalid connector event owner.');
      bindings.set('gmail', { userId: owner, source: 'gmail' });
    }
    for (const binding of api.pluginConfig.bindings ?? []) {
      if (
        !binding ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(binding.id) ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(binding.source) ||
        typeof binding.userId !== 'string' ||
        !binding.userId.trim() ||
        binding.userId.length > 200 ||
        !Number.isSafeInteger(binding.taskId) ||
        binding.taskId <= 0 ||
        bindings.has(binding.id)
      ) {
        throw new Error('Invalid or duplicate connector event binding.');
      }
      bindings.set(binding.id, binding);
    }
    api.registerInboundWebhook({
      name: 'change',
      method: 'POST',
      description:
        'Authenticated connector change relay; accepts bindingId and eventId only.',
      async handler(ctx) {
        if (
          !authenticated(ctx.req, api.getCredential('CONNECTOR_EVENTS_TOKEN'))
        ) {
          sendWebhookJson(ctx.res, 401, { error: 'Unauthorized' });
          return;
        }
        try {
          const body = await readWebhookJsonBody(ctx.req, {
            maxBytes: 4096,
            requireObject: true,
            tooLargeMessage: 'Event is too large.',
            invalidJsonMessage: 'Invalid JSON.',
          });
          if (
            Object.keys(body).some(
              (key) => !['bindingId', 'eventId'].includes(key),
            ) ||
            typeof body.bindingId !== 'string' ||
            typeof body.eventId !== 'string' ||
            !body.eventId.trim() ||
            body.eventId.length > 200
          ) {
            throw new WebhookHttpError(
              400,
              'Expected bindingId and nonempty eventId only.',
            );
          }
          const binding = bindings.get(body.bindingId);
          if (!binding) throw new WebhookHttpError(404, 'Unknown binding.');
          const change = {
            userId: binding.userId,
            source: binding.source,
            eventId: body.eventId,
          };
          const result = binding.taskId
            ? api.queueConnectorChange({ ...change, taskId: binding.taskId })
            : { results: api.queueConnectorSourceChange(change) };
          sendWebhookJson(ctx.res, 202, result);
        } catch (error) {
          if (error instanceof WebhookHttpError) {
            sendWebhookJson(ctx.res, error.statusCode, {
              error: error.message,
            });
          } else {
            api.logger.error(
              { err: error },
              'Could not queue connector change',
            );
            sendWebhookJson(ctx.res, 500, {
              error: 'Could not queue connector change.',
            });
          }
        }
      },
    });
  },
};
